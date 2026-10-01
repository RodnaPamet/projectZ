import { getToken } from 'next-auth/jwt';

import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { membershipContext } from '@/lib/auth/page-context';
import { checkSession } from '@/lib/auth/sessions';

jest.mock('next-auth/jwt', () => ({ getToken: jest.fn() }));
jest.mock('@/lib/auth/sessions', () => ({ checkSession: jest.fn() }));
// The membership is read from the database since #250. The real resolver
// reaches Prisma, which does not load under jsdom; context.test.ts covers what
// the context does with its answer.
jest.mock('@/lib/auth/page-context', () => ({ membershipContext: jest.fn() }));

const mockToken = getToken as unknown as jest.Mock;
const mockCheck = checkSession as unknown as jest.Mock;
const mockMembership = membershipContext as unknown as jest.Mock;

/** A read at club-a — no permission required, so only the session is in question. */
const req = {
  nextUrl: new URL('https://playerz.bg/api/v1/t/club-a/me'),
  method: 'GET',
  // A native caller: no Sec-Fetch-Site, no viewer header, no cookie jar entries.
  headers: { get: () => null },
  cookies: { getAll: () => [] },
} as never;
const BASE = { requestId: 'req_1' };

const signedIn = {
  sub: 'usr_1',
  userSessionId: 'ses_1',
  sessionVersion: 3,
  sessionSecret: 'deadbeef',
  memberships: [{ tenantId: 'tnt_a', tenantSlug: 'club-a', role: 'OWNER' }],
  membershipsTruncated: false,
};

beforeEach(() => {
  mockToken.mockReset();
  mockCheck.mockReset();
  mockMembership.mockReset();
  mockMembership.mockResolvedValue({
    kind: 'ok',
    ctx: {
      userId: 'usr_1',
      tenantId: 'tnt_a',
      tenantSlug: 'club-a',
      role: 'OWNER',
      permissions: ['admin.venue_manage'],
    },
  });
});

describe('contextFromRequest session enforcement', () => {
  it('a usable session produces an authenticated context', async () => {
    mockToken.mockResolvedValue(signedIn);
    mockCheck.mockResolvedValue({ usable: true });

    const ctx = await contextFromRequest(req, { ...BASE, slug: 'club-a' });

    expect(ctx.userId).toBe('usr_1');
    expect(ctx.tenantId).toBe('tnt_a');
    expect(ctx.permissions.length).toBeGreaterThan(0);
  });

  it.each([['revoked'], ['stale-version'], ['expired'], ['unknown'], ['no-session']])(
    'a %s session degrades to ANONYMOUS, with no tenant and no permissions',
    async (reason) => {
      // A signature that verifies is not a session anybody still wants. Without
      // this the token stays good until it expires: a password change does not
      // evict it and "sign out everywhere" never reaches it.
      mockToken.mockResolvedValue(signedIn);
      mockCheck.mockResolvedValue({ usable: false, reason });

      const ctx = await contextFromRequest(req, { ...BASE, slug: 'club-a' });

      expect(ctx.userId).toBeNull();
      expect(ctx.tenantId).toBeNull();
      expect(ctx.role).toBeNull();
      expect(ctx.permissions).toEqual([]);
      // Nor is the membership looked up for a session nobody wants any more.
      expect(mockMembership).not.toHaveBeenCalled();
    },
  );

  it('a dead session on a route that needs a permission is a 401, not an anonymous context', async () => {
    // The edge answers 401 before this runs. Handing the handler an anonymous
    // context anyway would leave the refusal to whichever handler remembered
    // to check — and one route on this tree (the venue-admin stub) had no
    // check at all, because it trusted the edge.
    mockToken.mockResolvedValue(signedIn);
    mockCheck.mockResolvedValue({ usable: false, reason: 'revoked' });

    const mutation = {
      nextUrl: new URL('https://playerz.bg/api/v1/t/club-a/bookings/b1/cancel'),
      method: 'POST',
      headers: { get: () => null },
      cookies: { getAll: () => [] },
    } as never;

    await expect(contextFromRequest(mutation, { ...BASE, slug: 'club-a' })).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('passes the token claims through to the check, not defaults', async () => {
    // Sending sessionVersion 0 instead of the token's value would make every
    // token look current, and the check would pass for exactly the tokens a
    // password change was meant to kill.
    mockToken.mockResolvedValue(signedIn);
    mockCheck.mockResolvedValue({ usable: true });

    await contextFromRequest(req, { ...BASE, slug: 'club-a' });

    expect(mockCheck).toHaveBeenCalledWith({
      userSessionId: 'ses_1',
      sessionVersion: 3,
      sessionSecret: 'deadbeef',
    });
  });

  it('does NOT hit the database for an anonymous request', async () => {
    // Public reads are the hot path. A session lookup for a caller with no
    // token would be a round trip to learn nothing.
    mockToken.mockResolvedValue(null);

    const ctx = await contextFromRequest(req, { ...BASE, slug: null });

    expect(ctx.userId).toBeNull();
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('a token with no sessionVersion claim cannot pass as version 0', async () => {
    // A pre-P25 token has no counter. Defaulting it to 0 would match a user
    // whose counter has never moved — i.e. most users — so it is sent as -1,
    // which no user ever has.
    mockToken.mockResolvedValue({ ...signedIn, sessionVersion: undefined });
    mockCheck.mockResolvedValue({ usable: false, reason: 'stale-version' });

    await contextFromRequest(req, { ...BASE, slug: 'club-a' });

    expect(mockCheck).toHaveBeenCalledWith(expect.objectContaining({ sessionVersion: -1 }));
  });
});
