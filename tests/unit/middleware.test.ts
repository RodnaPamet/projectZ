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

const get = (path: string) => middleware(new NextRequest(`https://playerz.bg${path}`));

/**
 * The edge let the request on to the route. `NextResponse.next()` marks itself
 * with this header; a status of 200 alone would also be true of a response the
 * middleware answered itself.
 */
const passedThrough = (res: Response) => res.headers.get('x-middleware-next') === '1';

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

  it('hands a club the token does not list to the route, UNDECIDED (#250)', async () => {
    // This was a 403 here: "not a member". It cannot be concluded from a token
    // — a player may have joined varna-squash by booking since signing in — so
    // the request goes on, and `contextFromRequest` refuses it there, from the
    // database, if the caller has no membership or lacks admin.venue_manage.
    mockedGetToken.mockResolvedValue(OWNER_AT_SOFIA_PLAYER_AT_PLOVDIV);

    const res = await post('/api/t/varna-squash/admin/venues');

    expect(passedThrough(res)).toBe(true);
  });

  it('answers "no such club" exactly as it answers "a club you are not in"', async () => {
    // Both pass through, and both reach a route that resolves them from one
    // query. Neither the edge nor the route can be used to enumerate clubs.
    mockedGetToken.mockResolvedValue(OWNER_AT_SOFIA_PLAYER_AT_PLOVDIV);

    const real = await post('/api/v1/t/varna-squash/bookings/b1/cancel');
    const invented = await post('/api/v1/t/no-such-club-anywhere/bookings/b1/cancel');

    expect(real.status).toBe(invented.status);
    expect([...real.headers.entries()]).toEqual([...invented.headers.entries()]);
  });

  it('skips its permission check when the list was truncated — the route checks instead', async () => {
    // This used to deny, and said why: "the routes do not re-check". They do
    // now, against the database, so club 51 is no longer refused mutations.
    mockedGetToken.mockResolvedValue({
      sub: 'u1',
      role: 'OWNER',
      permissions: ['admin.venue_manage'],
      memberships: [{ tenantSlug: 'sofia-padel', role: 'OWNER' }],
      membershipsTruncated: true,
    });

    const res = await post('/api/t/club-51/admin/venues');

    expect(passedThrough(res)).toBe(true);
  });
});

describe('middleware and a NATIVE access token (#250)', () => {
  // Exactly what `mintAccessToken` writes: identity and session, no clubs.
  const NATIVE = { sub: 'u1', userSessionId: 's1', sessionVersion: 0 };

  it('lets a native token through to its club — reads and writes alike', async () => {
    // Measured on main: every one of these was a 403 at the edge, on the
    // caller's own club, because a missing claim read as "not a member".
    mockedGetToken.mockResolvedValue(NATIVE);

    expect(passedThrough(await get('/api/v1/t/sofia-padel/me'))).toBe(true);
    expect(passedThrough(await get('/api/v1/t/sofia-padel/bookings'))).toBe(true);
    expect(passedThrough(await post('/api/v1/t/sofia-padel/bookings'))).toBe(true);
    expect(passedThrough(await post('/api/v1/t/sofia-padel/bookings/b1/cancel'))).toBe(true);
  });

  it('still refuses the same request with no token at all', async () => {
    mockedGetToken.mockResolvedValue(null);

    const res = await post('/api/v1/t/sofia-padel/bookings');

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
  });
});

describe('middleware sign-in redirect', () => {
  it('carries the WHOLE deep link to /login, query string included (#227)', async () => {
    // `/login` now honours `next` over role landing. A diary link for a given
    // day that lost its `?day=` would still land on the diary — on today.
    mockedGetToken.mockResolvedValue(null);

    const res = await get('/t/sofia-padel/admin/calendar?day=2026-10-01');

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('next')).toBe('/t/sofia-padel/admin/calendar?day=2026-10-01');
  });

  it('sends just the path when there is no query string', async () => {
    mockedGetToken.mockResolvedValue(null);

    const res = await get('/t/sofia-padel/admin/staff');

    expect(new URL(res.headers.get('location')!).searchParams.get('next')).toBe(
      '/t/sofia-padel/admin/staff',
    );
  });

  it.each(['/t/sofia-padel', '/t/sofia-padel/'])(
    'a club’s bare address, signed out, is its public page, not sign-in (#356, A03): %s',
    async (path) => {
      mockedGetToken.mockResolvedValue(null);

      const res = await get(path);

      expect(res.status).toBe(307);
      expect(new URL(res.headers.get('location')!).pathname).toBe('/clubs/sofia-padel');
    },
  );

  it('everything below the bare address still goes to sign-in', async () => {
    mockedGetToken.mockResolvedValue(null);

    const res = await get('/t/sofia-padel/admin');

    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
  });

  it('the public club page itself needs no session', async () => {
    mockedGetToken.mockResolvedValue(null);

    expect(passedThrough(await get('/clubs/sofia-padel'))).toBe(true);
  });
});
