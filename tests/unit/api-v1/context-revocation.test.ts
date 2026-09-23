import { getToken } from 'next-auth/jwt';

import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { checkSession } from '@/lib/auth/sessions';

jest.mock('next-auth/jwt', () => ({ getToken: jest.fn() }));
jest.mock('@/lib/auth/sessions', () => ({ checkSession: jest.fn() }));

const mockToken = getToken as unknown as jest.Mock;
const mockCheck = checkSession as unknown as jest.Mock;

const req = {} as never;
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
    },
  );

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
