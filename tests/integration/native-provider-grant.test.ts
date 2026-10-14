import { NextRequest } from 'next/server';

import { POST as token } from '@/app/api/v1/auth/token/route';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { verifyGoogleIdToken } from '@/lib/auth/native-grants';

import { prismaTestClient, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * THE APP'S GOOGLE SIGN-IN LANDS IN THE SAME ACCOUNT THE WEB'S DOES (#444).
 *
 * The verifier is a stand-in (its own tests use real signatures); the account
 * resolution, the session row and the token's acceptance by the Bearer
 * pipeline are real, against the database.
 */
jest.mock('@/lib/auth/native-grants', () => ({
  ...jest.requireActual('@/lib/auth/native-grants'),
  verifyGoogleIdToken: jest.fn(),
}));
const mockGoogle = verifyGoogleIdToken as jest.Mock;

describe('native Google sign-in', () => {
  const db = prismaTestClient();

  // A distinct IP per request: LOGIN_LIMIT is per IP and process-local, and the
  // suites would otherwise throttle each other (see native-auth.test.ts).
  let ip = 0;
  const signIn = async (email: string, extra: Record<string, unknown> = {}) => {
    mockGoogle.mockResolvedValue({
      provider: 'google',
      email,
      emailVerified: true,
      name: 'Петя от Google',
      picture: null,
    });
    const res = await token(
      new NextRequest('http://t/api/v1/auth/token', {
        method: 'POST',
        body: JSON.stringify({ grant: 'google', idToken: 'g', ...extra }),
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `10.44.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`,
          'user-agent': 'playerz-ios/1.0',
        },
      }),
      undefined,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { accessToken: string; refreshToken: string } }).data;
  };

  const userByEmail = (email: string) =>
    asAppSuperuser(db, (tx) =>
      tx.user.findUnique({
        where: { email },
        select: { id: true, name: true, accountKind: true, locale: true, emailVerified: true },
      }),
    );
  const sessionsOf = (userId: string) =>
    asAppSuperuser(db, (tx) =>
      tx.userSession.findMany({ where: { userId }, select: { userAgent: true, tenantId: true } }),
    );

  it('a first sign-in makes an undecided account in the app’s language, and the token works', async () => {
    const email = `native-google-${Date.now()}@playerz.test`;

    const tokens = await signIn(email, { locale: 'en' });

    const user = await userByEmail(email);
    expect(user).toMatchObject({ name: 'Петя от Google', accountKind: null, locale: 'en' });
    expect(user?.emailVerified).toBeInstanceOf(Date);
    expect(await sessionsOf(user!.id)).toEqual([{ userAgent: 'playerz-ios/1.0', tenantId: null }]);

    const ctx = await contextFromRequest(
      new NextRequest('http://t/api/v1/x', {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      }),
      { slug: null, requestId: 'req_native_google' },
    );
    expect(ctx.userId).toBe(user!.id);
  });

  it('an existing account with that address is the one signed into, unchanged', async () => {
    const t = await seedTenant({}, db);
    const owner = await asAppSuperuser(db, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: t.userId }, select: { email: true, name: true } }),
    );

    // The provider's case is not the account's: addresses match lower-cased.
    await signIn(owner.email);

    const user = await userByEmail(owner.email);
    expect(user?.id).toBe(t.userId);
    // The provider's name does not overwrite the one the account has.
    expect(user?.name).toBe(owner.name);
    expect(await sessionsOf(t.userId)).toHaveLength(1);
  });

  it('signing in again makes a second session, not a second account', async () => {
    const email = `native-again-${Date.now()}@playerz.test`;
    await signIn(email);
    await signIn(email);

    const users = await asAppSuperuser(db, (tx) => tx.user.findMany({ where: { email } }));
    expect(users).toHaveLength(1);
    expect(await sessionsOf(users[0].id)).toHaveLength(2);
  });
});
