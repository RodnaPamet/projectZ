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
  let userId: string;

  beforeEach(async () => {
    const t = await seedTenant({}, db);
    userId = t.userId;
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

  /**
   * The session row this test's sign-in created. The database is truncated
   * before every test and `signIn` is the only thing here that opens a
   * session, so the newest row for this user is that one.
   */
  const sessionRow = () =>
    asAppSuperuser(db, (tx) =>
      tx.userSession.findFirstOrThrow({ where: { userId }, orderBy: { createdAt: 'desc' } }),
    );

  /** rfc3339 truncates, so compare against the row's time floored to a second. */
  const toSecond = (d: Date) => Math.floor(d.getTime() / 1000) * 1000;

  it('refreshExpiresAt is the SESSION ROW deadline at sign-in', async () => {
    // Honest about what this proves: the row is created at now + 30 days and
    // the broken code returned now + 30 days, so this assertion passes either
    // way. It is here to catch the two drifting apart later — a shorter row, a
    // changed constant — and NOT as the regression test for #123. That is the
    // next case, and tests/unit/api-v1/native-token-expiry.test.ts.
    const d = await signIn();
    const row = await sessionRow();

    expect(new Date(String(d.refreshExpiresAt)).getTime()).toBe(toSecond(row.expiresAt));
  });

  it('refreshExpiresAt reports the row even when the row says something else', async () => {
    // ═══ #123 ═══
    //
    // The field used to be `now + REFRESH_TOKEN_TTL_SECONDS`, recomputed on
    // every response. Because the row is ALSO created at now + 30 days, the two
    // agree at sign-in and a test taken at sign-in cannot tell them apart — it
    // would pass on the broken code. Moving the row's deadline first is what
    // makes this decisive: only an implementation that reads the row can report
    // three days.
    //
    // It is not a contrived state either. The deadline is what
    // `rotateRefreshToken` enforces, so anything that shortens a session —
    // support closing one early, a future sweep — lands here, and the client
    // must be told the truth about it.
    const d = await signIn();

    const shortened = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await asAppSuperuser(db, (tx) =>
      tx.userSession.updateMany({ where: { userId }, data: { expiresAt: shortened } }),
    );

    const res = await refresh(
      post('http://t/api/v1/auth/refresh', { refreshToken: d.refreshToken }),
      undefined,
    );
    expect(res.status).toBe(200);
    const r = ((await res.json()) as { data: Record<string, string> }).data;

    expect(new Date(r.refreshExpiresAt).getTime()).toBe(toSecond(shortened));
  });

  it('refreshing does not push the deadline out', async () => {
    // A client that refreshes often must not read a session that renews itself.
    // Nothing writes `expiresAt` after the row is created, so every response in
    // a session names the same instant — the one sign-in fixed.
    const d = await signIn();
    const row = await sessionRow();

    const once = await refresh(
      post('http://t/api/v1/auth/refresh', { refreshToken: d.refreshToken }),
      undefined,
    );
    const first = ((await once.json()) as { data: Record<string, string> }).data;

    const twice = await refresh(
      post('http://t/api/v1/auth/refresh', { refreshToken: first.refreshToken ?? d.refreshToken }),
      undefined,
    );
    const second = ((await twice.json()) as { data: Record<string, string> }).data;

    expect(new Date(first.refreshExpiresAt).getTime()).toBe(toSecond(row.expiresAt));
    expect(second.refreshExpiresAt).toBe(first.refreshExpiresAt);
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
