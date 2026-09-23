/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

jest.mock('next-auth', () => ({
  __esModule: true,
  default: () => async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
}));
jest.mock('@/auth', () => ({ authOptions: {} }));

import { LOGIN_LIMIT } from '@/lib/security/rate-limit';

import { POST } from '@/app/api/auth/[...nextauth]/route';

/**
 * The credentials callback is a bcrypt oracle without this.
 *
 * `authorize()` burns equal time on every failure path, which defeats user
 * ENUMERATION. Nothing defeats BRUTE FORCE: an attacker may submit passwords
 * as fast as we will hash them. CSRF is not a control either — GET
 * /api/auth/csrf mints an unlimited supply of valid token pairs.
 *
 * LOGIN_LIMIT has existed since P03, with its threat model written out, and
 * had zero callers until this route.
 */
const credentialsPost = (ip: string) =>
  new NextRequest('http://t/api/auth/callback/credentials', {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
  });

describe('credentials login throttling', () => {
  it('allows attempts up to the limit, then 429s', async () => {
    const ip = `10.0.0.${Math.floor(Math.random() * 200) + 1}`;

    for (let i = 0; i < LOGIN_LIMIT.maxAttempts; i++) {
      const res = await POST(credentialsPost(ip), undefined);
      expect(res.status).toBe(200);
    }

    const blocked = await POST(credentialsPost(ip), undefined);
    expect(blocked.status).toBe(429);
  });

  it('the 429 says nothing about whether the account exists', async () => {
    // A throttle that only fires for real addresses is the enumeration oracle
    // dummyVerify exists to prevent, moved up a layer. This body is returned
    // on attempt eleven from an IP regardless of what was submitted.
    const ip = '10.1.2.3';
    for (let i = 0; i <= LOGIN_LIMIT.maxAttempts; i++) await POST(credentialsPost(ip), undefined);

    const res = await POST(credentialsPost(ip), undefined);
    const body = (await res.json()) as { error: { code: string; message: string } };

    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).not.toMatch(/email|account|user|exist/i);
  });

  it('sets retry-after so a client can back off instead of hammering', async () => {
    const ip = '10.9.9.9';
    for (let i = 0; i <= LOGIN_LIMIT.maxAttempts; i++) await POST(credentialsPost(ip), undefined);

    const res = await POST(credentialsPost(ip), undefined);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('throttles per IP, so one attacker cannot lock everybody out', async () => {
    const attacker = '10.5.5.5';
    for (let i = 0; i <= LOGIN_LIMIT.maxAttempts; i++)
      await POST(credentialsPost(attacker), undefined);
    expect((await POST(credentialsPost(attacker), undefined)).status).toBe(429);

    // A different IP is unaffected. Keying on the submitted EMAIL instead would
    // let an attacker lock a victim out of their own account by spraying their
    // address — a defence that becomes a denial of service.
    expect((await POST(credentialsPost('10.6.6.6'), undefined)).status).toBe(200);
  });

  it('does NOT throttle other auth endpoints', async () => {
    // OAuth callbacks carry state we must not drop, and /session is polled by
    // the client on every focus. Throttling those would break sign-in rather
    // than protect it.
    const ip = '10.7.7.7';
    for (let i = 0; i < LOGIN_LIMIT.maxAttempts + 5; i++) {
      const res = await POST(
        new NextRequest('http://t/api/auth/callback/google', {
          method: 'POST',
          headers: { 'x-forwarded-for': ip },
        }),
        undefined,
      );
      expect(res.status).toBe(200);
    }
  });
});
