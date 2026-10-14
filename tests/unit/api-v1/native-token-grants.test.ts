/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

import { appleSignIn } from '@/app-layer/usecases/apple-sign-in';
import { resolveProviderAccount } from '@/app-layer/usecases/provider-account';
import { POST as token } from '@/app/api/v1/auth/token/route';
import { readFacebookEmailPermission } from '@/lib/auth/facebook-permissions';
import {
  NativeGrantError,
  verifyAppleIdToken,
  verifyFacebookAccessToken,
  verifyFacebookIdToken,
  verifyGoogleIdToken,
} from '@/lib/auth/native-grants';
import { createUserSession } from '@/lib/auth/sessions';
import { verifyCredentials } from '@/lib/auth/verify-credentials';
import { checkRateLimit } from '@/lib/security/rate-limit';

/**
 * POST /api/v1/auth/token: THE APP'S GOOGLE AND FACEBOOK GRANTS (#444).
 *
 * The verifiers have their own tests against real signatures; here they are
 * stand-ins, and what is checked is the route's part: which grant runs, the
 * web's two refusals (no address; an address Google has not proved) before
 * any account is touched, the shared throttle, and the token pair at the end.
 */

jest.mock('@/lib/db/rls-middleware', () => ({ runAsSuperuser: jest.fn() }));
jest.mock('@/lib/auth/sessions', () => ({
  ...jest.requireActual('@/lib/auth/sessions'),
  createUserSession: jest.fn(async () => ({
    userSessionId: 'us-1',
    sessionVersion: 1,
    expiresAt: new Date('2026-11-13T10:00:00Z'),
  })),
  setRefreshToken: jest.fn(async () => undefined),
}));
jest.mock('@/lib/auth/verify-credentials', () => ({ verifyCredentials: jest.fn() }));
jest.mock('@/lib/security/rate-limit', () => ({
  ...jest.requireActual('@/lib/security/rate-limit'),
  checkRateLimit: jest.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
}));
jest.mock('@/lib/auth/native-grants', () => ({
  ...jest.requireActual('@/lib/auth/native-grants'),
  verifyGoogleIdToken: jest.fn(),
  verifyAppleIdToken: jest.fn(),
  verifyFacebookIdToken: jest.fn(),
  verifyFacebookAccessToken: jest.fn(),
}));
jest.mock('@/lib/auth/facebook-permissions', () => ({ readFacebookEmailPermission: jest.fn() }));
jest.mock('@/app-layer/usecases/apple-sign-in', () => ({
  ...jest.requireActual('@/app-layer/usecases/apple-sign-in'),
  appleSignIn: jest.fn(),
}));
jest.mock('@/app-layer/usecases/provider-account', () => ({
  resolveProviderAccount: jest.fn(async () => ({ userId: 'user-1' })),
}));

const mockGoogle = verifyGoogleIdToken as jest.Mock;
const mockApple = verifyAppleIdToken as jest.Mock;
const mockAppleSignIn = appleSignIn as jest.Mock;
const mockFbId = verifyFacebookIdToken as jest.Mock;
const mockFbAccess = verifyFacebookAccessToken as jest.Mock;
const mockPermission = readFacebookEmailPermission as jest.Mock;
const mockResolve = resolveProviderAccount as jest.Mock;
const mockThrottle = checkRateLimit as jest.Mock;
const mockCreate = createUserSession as jest.Mock;
const mockVerifyPassword = verifyCredentials as jest.Mock;

const person = (over: Record<string, unknown> = {}) => ({
  provider: 'google',
  email: 'petya@example.bg',
  emailVerified: true,
  name: 'Петя',
  picture: null,
  ...over,
});

const send = (body: unknown) =>
  token(
    new NextRequest('http://t/api/v1/auth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '10.9.9.9',
        'user-agent': 'playerz-ios/1.0',
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    undefined,
  );

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: Record<string, unknown> }).error;

const saved = { DEPLOY_ENV: process.env.DEPLOY_ENV, TEST: process.env.TEST_PASSWORD_SIGN_IN };
beforeEach(() => {
  jest.clearAllMocks();
  // A deployment: the password grant is off, so only the provider grants work.
  process.env.DEPLOY_ENV = 'production';
  delete process.env.TEST_PASSWORD_SIGN_IN;
  process.env.NEXTAUTH_SECRET ??= 'test-secret-for-native-token-grants'; // pragma: allowlist secret
});
afterAll(() => {
  process.env.DEPLOY_ENV = saved.DEPLOY_ENV;
  if (saved.TEST === undefined) delete process.env.TEST_PASSWORD_SIGN_IN;
  else process.env.TEST_PASSWORD_SIGN_IN = saved.TEST;
});

describe('the google grant', () => {
  it('verifies the ID token, resolves the account, and returns the token pair', async () => {
    mockGoogle.mockResolvedValue(person());

    const res = await send({ grant: 'google', idToken: 'g-id-token', locale: 'en' });

    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ tokenType: 'Bearer', refreshExpiresAt: '2026-11-13T10:00:00Z' });
    expect(typeof data.accessToken).toBe('string');
    expect(typeof data.refreshToken).toBe('string');

    expect(mockGoogle).toHaveBeenCalledWith('g-id-token');
    expect(mockResolve).toHaveBeenCalledWith({
      provider: 'google',
      email: 'petya@example.bg',
      name: 'Петя',
      picture: null,
      locale: 'en',
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', tenantId: null, userAgent: 'playerz-ios/1.0' }),
    );
    // The web's throttle key, drawn once.
    expect(mockThrottle).toHaveBeenCalledTimes(1);
    expect(mockThrottle.mock.calls[0][0]).toBe('login:10.9.9.9');
  });

  it('ignores a locale the app does not have', async () => {
    mockGoogle.mockResolvedValue(person());
    await send({ grant: 'google', idToken: 't', locale: 'fr' });
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ locale: null }));
  });

  it('refuses an address Google has not proved, touching no account', async () => {
    mockGoogle.mockResolvedValue(person({ emailVerified: false }));
    const res = await send({ grant: 'google', idToken: 't' });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({ code: 'EMAIL_UNVERIFIED' });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['INVALID_PROVIDER_TOKEN', 401],
    ['SIGN_IN_METHOD_DISABLED', 403],
    ['PROVIDER_UNAVAILABLE', 503],
  ] as const)('answers a verifier refusal %s with %i', async (code, status) => {
    mockGoogle.mockRejectedValue(new NativeGrantError(code, 'no'));
    const res = await send({ grant: 'google', idToken: 't' });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code });
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('needs an idToken', async () => {
    const res = await send({ grant: 'google' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockGoogle).not.toHaveBeenCalled();
  });
});

describe('the facebook grant', () => {
  it('takes a Facebook Login access token', async () => {
    mockFbAccess.mockResolvedValue(person({ provider: 'facebook' }));
    const res = await send({ grant: 'facebook', accessToken: 'fb-access' });
    expect(res.status).toBe(200);
    expect(mockFbAccess).toHaveBeenCalledWith('fb-access');
    expect(mockFbId).not.toHaveBeenCalled();
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ provider: 'facebook' }));
  });

  it('takes a Limited Login ID token, with its nonce', async () => {
    mockFbId.mockResolvedValue(person({ provider: 'facebook' }));
    const res = await send({ grant: 'facebook', idToken: 'fb-id', nonce: 'n-1' });
    expect(res.status).toBe(200);
    expect(mockFbId).toHaveBeenCalledWith('fb-id', { nonce: 'n-1' });
  });

  it.each([
    ['neither token', {}],
    ['both tokens', { accessToken: 'a', idToken: 'b' }],
  ])('needs exactly one token, not %s', async (_label, tokens) => {
    const res = await send({ grant: 'facebook', ...tokens });
    expect(res.status).toBe(400);
    expect(mockFbAccess).not.toHaveBeenCalled();
    expect(mockFbId).not.toHaveBeenCalled();
  });

  it('with no address, says whether asking again can help', async () => {
    mockFbAccess.mockResolvedValue(
      person({ provider: 'facebook', email: null, emailVerified: false }),
    );
    mockPermission.mockResolvedValue('granted');

    const res = await send({ grant: 'facebook', accessToken: 'fb-access' });

    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({
      code: 'EMAIL_REQUIRED',
      details: { emailPermission: 'granted' },
    });
    expect(mockPermission).toHaveBeenCalledWith('fb-access');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('a Limited Login token cannot ask Graph, so its missing address is unknown', async () => {
    mockFbId.mockResolvedValue(person({ provider: 'facebook', email: null, emailVerified: false }));
    const res = await send({ grant: 'facebook', idToken: 'fb-id' });
    expect(await errorOf(res)).toMatchObject({ details: { emailPermission: 'unknown' } });
    expect(mockPermission).not.toHaveBeenCalled();
  });
});

describe('the apple grant (#442)', () => {
  const appleId = person({ provider: 'apple', subject: 'sub-1', privateEmail: false });

  it('signs in an Apple ID the use case knows, with the name the app sent', async () => {
    mockApple.mockResolvedValue(appleId);
    mockAppleSignIn.mockResolvedValue({ userId: 'user-apple' });

    const res = await send({
      grant: 'apple',
      idToken: 'a-id',
      nonce: 'n',
      givenName: ' Петя ',
      familyName: 'Иванова',
      locale: 'bg',
    });

    expect(res.status).toBe(200);
    expect(mockApple).toHaveBeenCalledWith('a-id', { nonce: 'n' });
    expect(mockAppleSignIn).toHaveBeenCalledWith(appleId, 'Петя Иванова', 'bg');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-apple' }));
    expect(mockThrottle).toHaveBeenCalledTimes(1);
  });

  it('a hidden address stops with a ticket, and no session', async () => {
    mockApple.mockResolvedValue({ ...appleId, privateEmail: true });
    mockAppleSignIn.mockResolvedValue({ ticket: 'the-ticket' });

    const res = await send({ grant: 'apple', idToken: 'a-id' });

    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({
      code: 'REAL_EMAIL_REQUIRED',
      details: { ticket: 'the-ticket' },
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('a refused Apple token is the same 401 as any provider’s', async () => {
    mockApple.mockRejectedValue(new NativeGrantError('INVALID_PROVIDER_TOKEN', 'no'));
    const res = await send({ grant: 'apple', idToken: 'a-id' });
    expect(res.status).toBe(401);
    expect(mockAppleSignIn).not.toHaveBeenCalled();
  });
});

describe('the grants together', () => {
  it('names an unknown grant without drawing the throttle', async () => {
    const res = await send({ grant: 'microsoft', idToken: 't' });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatchObject({ code: 'UNSUPPORTED_GRANT' });
    expect(mockThrottle).not.toHaveBeenCalled();
  });

  it('a throttled IP is refused before any provider is asked', async () => {
    mockThrottle.mockResolvedValueOnce({ allowed: false, retryAfterMs: 61_000 });
    const res = await send({ grant: 'google', idToken: 't' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('61');
    expect(mockGoogle).not.toHaveBeenCalled();
  });

  it('the password shape is still refused in a deployment, before the throttle', async () => {
    for (const body of [
      { email: 'a@b.bg', password: 'x' },
      { grant: 'password', email: 'a@b.bg', password: 'x' },
      'not json',
    ]) {
      const res = await send(body);
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toMatchObject({ code: 'PASSWORD_SIGN_IN_DISABLED' });
    }
    expect(mockThrottle).not.toHaveBeenCalled();
    expect(mockVerifyPassword).not.toHaveBeenCalled();
  });
});
