/**
 * @jest-environment node
 *
 * The edge runtime has fetch-API globals (Request/Response); jsdom does not,
 * and `next/server` touches Request at import time. Node it is.
 */

/**
 * The edge escalation, closed end to end.
 *
 * `guard.test.ts` proves `permissionsForPath` derives the right answer. This
 * proves the middleware ASKS it — which is the half that was actually broken.
 * The old code called `checkTenantAccess` correctly and then checked
 * permissions against a different, frozen array, so a guard that was right in
 * isolation still let the mutation through.
 */

import { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

import { middleware } from '@/middleware';

jest.mock('next-auth/jwt', () => ({ getToken: jest.fn() }));

const mockedGetToken = getToken as unknown as jest.Mock;

/**
 * A club owner who also plays somewhere else. `permissions` and `role` are the
 * frozen memberships[0] claims auth.ts mints — present, wrong for the second
 * club, and exactly what the middleware used to trust.
 */
const OWNER_AT_SOFIA_PLAYER_AT_PLOVDIV = {
  sub: 'u1',
  role: 'OWNER',
  permissions: [
    'admin.venue_manage',
    'admin.staff_manage',
    'admin.pricing_manage',
    'admin.tenant_lifecycle',
  ],
  memberships: [
    { tenantSlug: 'sofia-padel', role: 'OWNER' },
    { tenantSlug: 'plovdiv-tennis', role: 'PLAYER' },
  ],
};

const post = (path: string) =>
  middleware(new NextRequest(`https://playerz.bg${path}`, { method: 'POST' }));

beforeEach(() => {
  mockedGetToken.mockReset();
});

describe('middleware permission check', () => {
  it('lets the owner manage venues at the club they own', async () => {
    mockedGetToken.mockResolvedValue(OWNER_AT_SOFIA_PLAYER_AT_PLOVDIV);

    const res = await post('/api/t/sofia-padel/admin/venues');

    expect(res.status).toBe(200);
  });

  it('BLOCKS the same owner from managing venues at the club they only play at', async () => {
    // Same token, same verb, one slug apart. Before the fix this returned 200:
    // checkTenantAccess said "yes, a member of plovdiv-tennis" — true — and the
    // permission check then read the OWNER permissions minted from sofia-padel.
    mockedGetToken.mockResolvedValue(OWNER_AT_SOFIA_PLAYER_AT_PLOVDIV);

    const res = await post('/api/t/plovdiv-tennis/admin/venues');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'Forbidden',
        details: { requiredPermission: 'admin.venue_manage' },
      },
    });
  });

  it('blocks it on the versioned API surface too', async () => {
    // The native client talks to /api/v1/**. A fix that only covered the web
    // paths would leave the escalation live for exactly the client this whole
    // effort exists to serve.
    mockedGetToken.mockResolvedValue(OWNER_AT_SOFIA_PLAYER_AT_PLOVDIV);

    const res = await post('/api/v1/t/plovdiv-tennis/admin/venues');

    expect(res.status).toBe(403);
  });

  it('still lets a plain read through at the club they only play at', async () => {
    // The fix must not turn into "members of a club they do not own get
    // nothing" — the mutation is blocked, the membership is not.
    mockedGetToken.mockResolvedValue(OWNER_AT_SOFIA_PLAYER_AT_PLOVDIV);

    const res = await middleware(
      new NextRequest('https://playerz.bg/api/t/plovdiv-tennis/admin/venues', { method: 'GET' }),
    );

    expect(res.status).toBe(200);
  });

  it('still denies a non-member before permissions are even considered', async () => {
    mockedGetToken.mockResolvedValue(OWNER_AT_SOFIA_PLAYER_AT_PLOVDIV);

    const res = await post('/api/t/varna-squash/admin/venues');

    expect(res.status).toBe(403);
    // No `requiredPermission` — this is the tenant branch, which stays opaque
    // so it cannot be used to enumerate tenants.
    await expect(res.json()).resolves.toEqual({
      error: { code: 'FORBIDDEN', message: 'Forbidden' },
    });
  });

  it('denies the mutation when the membership list was truncated', async () => {
    // Fail closed: an incomplete list is not permission to skip the check.
    mockedGetToken.mockResolvedValue({
      sub: 'u1',
      role: 'OWNER',
      permissions: ['admin.venue_manage'],
      memberships: [{ tenantSlug: 'sofia-padel', role: 'OWNER' }],
      membershipsTruncated: true,
    });

    const res = await post('/api/t/club-51/admin/venues');

    expect(res.status).toBe(403);
  });
});
