import { NextRequest } from 'next/server';

import { POST as logout } from '@/app/api/v1/auth/logout/route';
import { POST as refresh } from '@/app/api/v1/auth/refresh/route';
import { POST as token } from '@/app/api/v1/auth/token/route';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { hashPassword } from '@/lib/auth/passwords';

import { prismaTestClient, seedTenant } from '../helpers/db';
import { asAppSuperuser } from '../helpers/rls';

/**
 * The native token flow, end to end.
 *
 * The assertion that matters is not "the endpoint returns 200" — it is that a
 * token minted here is ACCEPTED as a Bearer credential by the same pipeline
 * the web uses. That is the whole claim of step 6b.
 */
describe('native auth', () => {
  const db = prismaTestClient();
  const PASSWORD = 'correct horse battery staple';
  let email: string;

  beforeEach(async () => {
    const t = await seedTenant({}, db);
    email = `native-${Date.now()}@playerz.test`;
    const pwHash = await hashPassword(PASSWORD);
    await asAppSuperuser(db, (tx) =>
      tx.user.update({
        where: { id: t.userId },
        data: { email, passwordHash: pwHash },
      }),
    );
  });

  /**
   * A DISTINCT IP per request, deliberately.
   *
   * LOGIN_LIMIT is 10 attempts per 15 minutes keyed on IP, and `rate-limit.ts`
   * keeps a process-local Map that `resetDatabase` does not touch. Sharing one
   * address across the suite means the tests throttle each other — which is
   * exactly what happened: the ninth sign-in got a 429 where the test expected
   * a 401, and only in the full run, never in isolation.
   *
   * The throttle itself is asserted deliberately at the end of this file, on
   * an address used for nothing else.
   */
  let ipCounter = 0;
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    new NextRequest(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`,
        ...headers,
      },
    });

  const signIn = async () => {
    const res = await token(
      post('http://t/api/v1/auth/token', { email, password: PASSWORD }),
      undefined,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Record<string, string | number | null> }).data;
  };

  it('issues a token pair for correct credentials', async () => {
    const d = await signIn();

    expect(d.tokenType).toBe('Bearer');
    expect(typeof d.accessToken).toBe('string');
    expect(typeof d.refreshToken).toBe('string');
    expect(Number(d.expiresIn)).toBeGreaterThan(0);
  });

  it('the expiry has NO fractional seconds — Swift .iso8601 rejects them', async () => {
    // toISOString() gives 2026-09-21T14:13:20.123Z, which fails at the DECODER,
    // naming the whole response rather than the field.
    const d = await signIn();
    expect(String(d.expiresAt)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(String(d.refreshExpiresAt)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('THE POINT: the access token authenticates as a Bearer credential', async () => {
    const d = await signIn();

    const ctx = await contextFromRequest(
      new NextRequest('http://t/api/v1/x', {
        headers: { authorization: `Bearer ${d.accessToken}` },
      }),
      { slug: null, requestId: 'req_1' },
    );

    // Not anonymous — the session was found, not revoked, not stale.
    expect(ctx.userId).toBeTruthy();
  });

  it('rejects a wrong password with ONE opaque message', async () => {
    const res = await token(
      post('http://t/api/v1/auth/token', { email, password: 'wrong' }),
      undefined,
    );
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(401);

    // "Invalid email or password" is the CORRECT phrasing — it names the two
    // fields without saying which was wrong. What must never appear is a
    // phrase that resolves the ambiguity, which is what an enumeration oracle
    // actually looks like.
    //
    // (My first version of this assertion banned the word "email" outright and
    // failed on the right answer.)
    expect(body.error.message).not.toMatch(
      /no such|not found|does not exist|unknown (user|account|email)|incorrect password|wrong password/i,
    );
  });

  it('an unknown account fails identically to a wrong password', async () => {
    const a = await token(
      post('http://t/api/v1/auth/token', { email, password: 'wrong' }),
      undefined,
    );
    const b = await token(
      post('http://t/api/v1/auth/token', { email: 'nobody@nowhere.test', password: 'wrong' }),
      undefined,
    );

    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  });

  it('refresh returns a working access token AND rotates', async () => {
    const d = await signIn();

    const res = await refresh(
      post('http://t/api/v1/auth/refresh', { refreshToken: d.refreshToken }),
      undefined,
    );
    expect(res.status).toBe(200);
    const r = ((await res.json()) as { data: Record<string, string | null> }).data;

    expect(r.refreshToken).not.toBe(d.refreshToken);

    // The refreshed token must actually work. It carries no sessionSecret, so
    // this is the assertion that catches the binding mistake.
    const ctx = await contextFromRequest(
      new NextRequest('http://t/x', { headers: { authorization: `Bearer ${r.accessToken}` } }),
      { slug: null, requestId: 'req_2' },
    );
    expect(ctx.userId).toBeTruthy();
  });

  it('logout revokes THIS session, and the access token stops working', async () => {
    const d = await signIn();

    const res = await logout(
      post('http://t/api/v1/auth/logout', {}, { authorization: `Bearer ${d.accessToken}` }),
      undefined,
    );
    expect(res.status).toBe(204);

    const ctx = await contextFromRequest(
      new NextRequest('http://t/x', { headers: { authorization: `Bearer ${d.accessToken}` } }),
      { slug: null, requestId: 'req_3' },
    );
    expect(ctx.userId).toBeNull();
  });

  it('logout is idempotent — twice is not an error', async () => {
    const d = await signIn();
    const req = () =>
      post('http://t/api/v1/auth/logout', {}, { authorization: `Bearer ${d.accessToken}` });

    expect((await logout(req(), undefined)).status).toBe(204);
    // A sign-out button that can "fail" is a sign-out button that spins.
    expect((await logout(req(), undefined)).status).toBe(204);
  });

  it('a refresh token is dead after logout', async () => {
    const d = await signIn();
    await logout(
      post('http://t/api/v1/auth/logout', {}, { authorization: `Bearer ${d.accessToken}` }),
      undefined,
    );

    const res = await refresh(
      post('http://t/api/v1/auth/refresh', { refreshToken: d.refreshToken }),
      undefined,
    );
    expect(res.status).toBe(401);
  });

  it('shares the WEB login throttle — this is not a way around it', async () => {
    // /auth/token is the SECOND password endpoint in the app. #95 wired
    // LOGIN_LIMIT to POST /api/auth/callback/credentials keyed `login:<ip>`.
    //
    // If this endpoint used its own key, or the wrapper's 60/min mutation
    // default, it would be roughly ninety times the budget — reachable by
    // pointing the same script at a different URL.
    const ip = '10.250.250.250';
    const attempt = () =>
      token(
        new NextRequest('http://t/api/v1/auth/token', {
          method: 'POST',
          body: JSON.stringify({ email, password: 'wrong' }),
          headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        }),
        undefined,
      );

    let sawRateLimit = false;
    for (let i = 0; i < 15; i++) {
      if ((await attempt()).status === 429) {
        sawRateLimit = true;
        break;
      }
    }

    expect(sawRateLimit).toBe(true);
  }, 30_000);
});
