/**
 * @jest-environment node
 */

/**
 * `/api/auth/session` SIGNS OUT A SESSION THAT WAS TAKEN BACK (#370).
 *
 * next-auth's session route runs the jwt callback on the cookie it is handed
 * and, if the callback throws, expires the cookie and answers `{}`. So the
 * callback asks `checkSession` about every token it did not just mint: a
 * deleted account (its session rows are gone) or a revoked session is signed
 * out there too, not only by the routes and pages. A database that does not
 * answer is not a revocation, and leaves the token alone.
 *
 * The real thing, against a real database, is in
 * tests/integration/account-deletion.test.ts.
 */

const checkSession = jest.fn();

jest.mock('@/lib/db/prisma', () => ({ prisma: {} }));
jest.mock('@/lib/db/rls-middleware', () => ({
  runAsSuperuser: jest.fn(),
}));
jest.mock('@/lib/auth/sessions', () => ({
  SESSION_MAX_AGE_SECONDS: 604800,
  checkSession: (...a: unknown[]) => checkSession(...a),
  createUserSession: jest.fn(),
  newSessionSecret: jest.fn(() => 'secret'),
}));

import { authOptions, SessionRevokedError } from '@/auth';

type Token = Record<string, unknown>;
const jwt = (args: { token: Token; trigger?: string }) =>
  (authOptions.callbacks!.jwt as unknown as (a: unknown) => Promise<Token>)({
    ...args,
    user: undefined,
  });

const TOKEN: Token = {
  sub: 'cuser0000000000000000001',
  userSessionId: 'csess0000000000000000001',
  sessionVersion: 3,
  sessionSecret: 'abc',
};

beforeEach(() => checkSession.mockReset());

describe('the jwt callback checks the session it is handed (#370)', () => {
  it('a live session: the token comes back unchanged, checked with its own claims', async () => {
    checkSession.mockResolvedValue({ usable: true });
    await expect(jwt({ token: { ...TOKEN } })).resolves.toMatchObject(TOKEN);
    expect(checkSession).toHaveBeenCalledWith({
      userSessionId: 'csess0000000000000000001',
      sessionVersion: 3,
      sessionSecret: 'abc',
    });
  });

  it.each(['unknown', 'revoked', 'expired', 'stale-version', 'no-session'])(
    'a session that is %s: it throws, which next-auth answers with an expired cookie',
    async (reason) => {
      checkSession.mockResolvedValue({ usable: false, reason });
      await expect(jwt({ token: { ...TOKEN } })).rejects.toBeInstanceOf(SessionRevokedError);
    },
  );

  it('a token with no session claims is checked as one (and refused)', async () => {
    checkSession.mockResolvedValue({ usable: false, reason: 'no-session' });
    await expect(jwt({ token: { sub: 'cuser0000000000000000001' } })).rejects.toBeInstanceOf(
      SessionRevokedError,
    );
    expect(checkSession).toHaveBeenCalledWith({
      userSessionId: null,
      sessionVersion: -1,
      sessionSecret: null,
    });
  });

  it('a database that does not answer leaves the token alone', async () => {
    checkSession.mockRejectedValue(new Error('connection refused'));
    await expect(jwt({ token: { ...TOKEN } })).resolves.toMatchObject(TOKEN);
  });

  it('an anonymous token is not checked', async () => {
    await expect(jwt({ token: {} })).resolves.toEqual({});
    expect(checkSession).not.toHaveBeenCalled();
  });
});
