/**
 * @jest-environment node
 */

/**
 * A HEADER THAT GREETS A REVOKED SESSION BY NAME IS THE MOST CONVINCING
 * POSSIBLE LIE ABOUT BEING SIGNED IN.
 *
 * `signedInIdentity` reads the name and email from the TOKEN rather than the
 * database — it renders on every page, and a query per page view for a display
 * name is not worth it. The session check is the part that is NOT skipped, and
 * this is what pins that: `checkSession` is what makes "sign out everywhere"
 * and a password change actually evict a token.
 */

const getToken = jest.fn();
const checkSession = jest.fn();

jest.mock('next/headers', () => ({
  cookies: async () => ({}),
  headers: async () => ({}),
}));
jest.mock('next-auth/jwt', () => ({ getToken: () => getToken() }));
jest.mock('@/lib/auth/sessions', () => ({ checkSession: () => checkSession() }));
jest.mock('@/lib/db/rls-middleware', () => ({ runAsSuperuser: jest.fn() }));

import { signedInIdentity } from '@/lib/auth/page-context';

const LIVE = {
  sub: 'user-1',
  name: 'Ivo',
  email: 'ivo@example.bg',
  userSessionId: 'sess-1',
  sessionVersion: 3,
  sessionSecret: 'secret',
};

beforeEach(() => {
  getToken.mockReset();
  checkSession.mockReset();
  checkSession.mockResolvedValue({ usable: true });
});

describe('signedInIdentity', () => {
  it('returns the identity from a live session', async () => {
    getToken.mockResolvedValue(LIVE);

    await expect(signedInIdentity()).resolves.toEqual({
      userId: 'user-1',
      name: 'Ivo',
      email: 'ivo@example.bg',
    });
  });

  it('returns null when the session has been REVOKED', async () => {
    // The whole reason the session check survives the token-only read. A
    // signature still verifies long after somebody signed out everywhere.
    getToken.mockResolvedValue(LIVE);
    checkSession.mockResolvedValue({ usable: false });

    await expect(signedInIdentity()).resolves.toBeNull();
  });

  it('returns null with no token at all', async () => {
    getToken.mockResolvedValue(null);

    await expect(signedInIdentity()).resolves.toBeNull();
    // Not even asked: there is no session to check.
    expect(checkSession).not.toHaveBeenCalled();
  });

  it('returns null for a token with no subject', async () => {
    getToken.mockResolvedValue({ ...LIVE, sub: undefined });

    await expect(signedInIdentity()).resolves.toBeNull();
  });

  it('nulls a non-string name rather than rendering it', async () => {
    // Whatever a provider puts in the token reaches a JSX text node. An object
    // there is a React crash on a header that renders on every page.
    getToken.mockResolvedValue({ ...LIVE, name: { given: 'Ivo' }, email: 42 });

    await expect(signedInIdentity()).resolves.toEqual({
      userId: 'user-1',
      name: null,
      email: null,
    });
  });
});
