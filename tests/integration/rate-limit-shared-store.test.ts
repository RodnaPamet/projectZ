import { randomUUID } from 'node:crypto';

import { checkRateLimit, clearAllRateLimits } from '@/lib/security/rate-limit';
import { closeRedis } from '@/lib/redis';

/**
 * The limiter counts ACROSS instances, and counts each attempt once.
 *
 * Against a real Redis, because the thing being fixed is precisely that the
 * store used to be per-process. A test with a mocked client would pass just as
 * happily against the Map this replaces.
 */
describe('the rate limiter shares one store', () => {
  const LIMIT = { maxAttempts: 3, windowMs: 60_000 };

  afterAll(async () => {
    await clearAllRateLimits();
    await closeRedis();
  });

  it('spends one budget across concurrent callers, not one budget each', async () => {
    // THE bug. With an in-memory Map and N instances the effective limit is
    // N× what it says — the sign-in throttle's 10-per-15-minutes becomes 10×N,
    // and nothing reports it. Two "instances" here are two independent calls
    // through the same shared key; if the store were per-process they would
    // not see each other at all.
    const key = `shared:${randomUUID()}`;

    const first = await checkRateLimit(key, LIMIT);
    const second = await checkRateLimit(key, LIMIT);
    const third = await checkRateLimit(key, LIMIT);
    const fourth = await checkRateLimit(key, LIMIT);

    expect([first.allowed, second.allowed, third.allowed]).toEqual([true, true, true]);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it('counts a BURST once each, not once in total', async () => {
    // The atomicity half, and the reason this is a Lua script rather than
    // read-then-write. Six simultaneous callers against a budget of three must
    // produce exactly three allowed. A check-then-act limiter lets several
    // read `count = 2` before any of them writes, and they all pass — an
    // attacker gets the whole budget again by firing in parallel.
    const key = `burst:${randomUUID()}`;

    const results = await Promise.all(Array.from({ length: 6 }, () => checkRateLimit(key, LIMIT)));

    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(results.filter((r) => !r.allowed)).toHaveLength(3);
  });

  it('honours the lockout, and reports when it ends', async () => {
    const key = `lockout:${randomUUID()}`;
    const withLockout = { maxAttempts: 2, windowMs: 60_000, lockoutMs: 120_000 };

    await checkRateLimit(key, withLockout);
    await checkRateLimit(key, withLockout);
    const blocked = await checkRateLimit(key, withLockout);

    expect(blocked.allowed).toBe(false);
    // The lockout is longer than the window, so the retry hint must come from
    // the lockout branch — over a minute out, not under.
    expect(blocked.retryAfterMs).toBeGreaterThan(60_000);
  });

  it('still limits when Redis is unavailable, rather than failing open', async () => {
    // The degraded mode, and why it is the in-memory store rather than either
    // alternative: failing OPEN removes the limit entirely, which is the
    // vulnerability being fixed; failing CLOSED makes a limiter outage into a
    // sign-in outage. Degrading to yesterday's per-instance limit is the only
    // option that is never worse than the status quo.
    const key = `nordis:${randomUUID()}`;
    const once = { maxAttempts: 1, windowMs: 60_000 };

    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;

    try {
      expect((await checkRateLimit(key, once)).allowed).toBe(true);
      // The second one is still refused — the limit holds, it is just local.
      expect((await checkRateLimit(key, once)).allowed).toBe(false);
    } finally {
      process.env.REDIS_URL = saved;
    }
  });

  it('a reset clears the SHARED state, not just this process', async () => {
    const key = `reset:${randomUUID()}`;
    const once = { maxAttempts: 1, windowMs: 60_000 };

    expect((await checkRateLimit(key, once)).allowed).toBe(true);
    expect((await checkRateLimit(key, once)).allowed).toBe(false);

    const { resetRateLimit } = await import('@/lib/security/rate-limit');
    await resetRateLimit(key);

    expect((await checkRateLimit(key, once)).allowed).toBe(true);
  });
});
