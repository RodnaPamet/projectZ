/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

import { POST as token } from '@/app/api/v1/auth/token/route';
import { createUserSession } from '@/lib/auth/sessions';
import { verifyCredentials } from '@/lib/auth/verify-credentials';
import { checkRateLimit } from '@/lib/security/rate-limit';

/**
 * POST /api/v1/auth/token HAS NO GRANT IN A DEPLOYMENT (#361).
 *
 * Its only grant is email + password, which exists for the test suites only.
 * In production and on staging it refuses EVERY request, before the login
 * throttle, before the body is read and without a bcrypt — so a password
 * cannot be tried there at all, not merely fail. jest.setup.ts makes the
 * whole run a test run, so each case here sets the environment it is about.
 */

jest.mock('@/lib/db/rls-middleware', () => ({ runAsSuperuser: jest.fn() }));
jest.mock('@/lib/auth/sessions', () => ({
  ...jest.requireActual('@/lib/auth/sessions'),
  createUserSession: jest.fn(),
  setRefreshToken: jest.fn(async () => undefined),
}));
jest.mock('@/lib/auth/verify-credentials', () => ({ verifyCredentials: jest.fn() }));
jest.mock('@/lib/security/rate-limit', () => ({
  ...jest.requireActual('@/lib/security/rate-limit'),
  checkRateLimit: jest.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
}));

const mockVerify = verifyCredentials as unknown as jest.Mock;
const mockThrottle = checkRateLimit as unknown as jest.Mock;
const mockCreate = createUserSession as unknown as jest.Mock;

const KEYS = ['TEST_PASSWORD_SIGN_IN', 'DEPLOY_ENV'] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const k of KEYS) saved.set(k, process.env[k]);
  mockVerify.mockReset();
  mockThrottle.mockClear();
  mockCreate.mockReset();
});
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const signIn = () =>
  token(
    new NextRequest('http://t/api/v1/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.9' },
      body: JSON.stringify({ email: 'owner@club.bg', password: 'correct horse' }),
    }),
    undefined,
  );

describe('POST /auth/token in a deployment', () => {
  it.each([
    ['production, DEPLOY_ENV unset', undefined],
    ['production', 'production'],
    ['staging', 'staging'],
  ])('%s: 403 PASSWORD_SIGN_IN_DISABLED, even with the test flag set', async (_label, deploy) => {
    process.env.TEST_PASSWORD_SIGN_IN = '1';
    if (deploy) process.env.DEPLOY_ENV = deploy;
    else delete process.env.DEPLOY_ENV;

    const res = await signIn();

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatchObject({ code: 'PASSWORD_SIGN_IN_DISABLED' });
    // Refused before any of it: no throttle draw, no credential check, no row.
    expect(mockThrottle).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a test run without the flag refuses the same way', async () => {
    process.env.DEPLOY_ENV = 'test';
    delete process.env.TEST_PASSWORD_SIGN_IN;

    const res = await signIn();
    expect(res.status).toBe(403);
    expect(mockVerify).not.toHaveBeenCalled();
  });
});

describe('POST /auth/token in a test run that asked for passwords', () => {
  it('checks the credentials as before', async () => {
    process.env.DEPLOY_ENV = 'test';
    process.env.TEST_PASSWORD_SIGN_IN = '1';
    mockVerify.mockResolvedValue(null);

    const res = await signIn();

    expect(mockThrottle).toHaveBeenCalledTimes(1);
    expect(mockVerify).toHaveBeenCalledWith('owner@club.bg', 'correct horse');
    expect(res.status).toBe(401);
  });
});
