/**
 * @jest-environment node
 *
 * `next/server` touches the fetch-API `Request` at import time and jsdom has
 * no such global — the same reason tests/unit/middleware.test.ts pins node.
 */

import { NextRequest } from 'next/server';

import { clearAllRateLimits, enforceRateLimit } from '@/lib/security/rate-limit-middleware';

/**
 * THE 429 BODY IS THE CANONICAL ENVELOPE, AND NOTHING ELSE (#124).
 *
 * `buildTooManyRequestsResponse` used to put `retryAfterSeconds` and `scope`
 * inside `error`. No other error in the API has extra keys there, so a native
 * client — which decodes ONE error type — met a shape its decoder had never
 * been given: dropped silently by a lenient decoder, fatal to a strict one.
 *
 * ═══ WHY THIS IS A UNIT TEST AND NOT A LINE IN THE GUARDRAIL ═══
 *
 * tests/guardrails/api-error-envelope.test.ts could not have caught this and
 * still cannot. Two independent reasons, both worth knowing before anyone
 * assumes this file is redundant:
 *
 *   1. Its SOURCES are `src/middleware.ts` plus `src/app/api/**\/route.ts`.
 *      This body is built in src/lib/security/, which it never reads.
 *   2. Its rule is "the value of `error` is an object literal with `code` and
 *      `message`". EXTRA keys satisfy that. Even scanning this file, it would
 *      have passed the old body.
 *
 * So the assertion here is deliberately the one the guardrail does not make:
 * that `error` carries NO key outside the canonical envelope.
 */

/**
 * The fields `ApiErrorResponse` (src/lib/errors/types.ts) defines. Anything
 * else on `error` is a shape a generated client was not built for.
 */
const CANONICAL_ERROR_FIELDS = new Set(['code', 'message', 'requestId', 'details']);

/** One request per minute, so the second one is always refused. */
const ONE_PER_MINUTE = { maxAttempts: 1, windowMs: 60_000 };

const request = () =>
  new NextRequest('https://playerz.bg/api/v1/t/sofia-padel/bookings', {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.7' },
  });

/**
 * Trip the limiter and return the response it refuses with.
 *
 * `scope` is a sentinel rather than the real `api-mutation`: it makes the
 * "the bucket name does not reach the client" assertion below unambiguous,
 * because no other part of the response could contain this string by chance.
 */
const SENTINEL_SCOPE = 'internal-bucket-name-that-must-not-ship';

async function blockedResponse() {
  const scope = { scope: SENTINEL_SCOPE, config: ONE_PER_MINUTE };
  await enforceRateLimit(request(), scope);
  const { response } = await enforceRateLimit(request(), scope);

  // Without this the suite would quietly test nothing if the limiter stopped
  // blocking — every assertion below lives on `response`.
  if (!response) throw new Error('the limiter allowed the second request; the fixture is broken');
  return response;
}

beforeEach(async () => {
  // The store is module-level state shared by every test in this process.
  // AWAITED. It clears Redis as well as the Map now, and an un-awaited clear
  // lands mid-test — deleting the key between the two calls below, so the
  // second one starts fresh and is allowed. That is what broke this suite.
  await clearAllRateLimits();
});

describe('the rate-limit 429 body', () => {
  it('is the canonical envelope and carries no foreign keys', async () => {
    const response = await blockedResponse();
    const body = (await response.json()) as { error: Record<string, unknown> };

    expect(response.status).toBe(429);
    expect(Object.keys(body)).toEqual(['error']);

    // Listing what is FOREIGN rather than asserting an exact key set: an exact
    // set would also fail the day someone legitimately adds `requestId`, which
    // is part of the envelope. Only a key outside it is the defect.
    const foreign = Object.keys(body.error).filter((k) => !CANONICAL_ERROR_FIELDS.has(k));
    expect(foreign).toEqual([]);

    expect(body.error.code).toBe('RATE_LIMITED');
    expect(typeof body.error.message).toBe('string');
  });

  it('never names the limiter bucket that blocked the request', async () => {
    // Which internal budget a caller exhausted is not actionable for them and
    // maps our rate-limiting topology for anyone willing to trip it.
    const response = await blockedResponse();

    expect(JSON.stringify(await response.json())).not.toContain(SENTINEL_SCOPE);
  });

  it('still tells the caller how long to wait, via Retry-After', async () => {
    // The retry hint is the one genuinely useful thing in a 429. Dropping it
    // from the body is only correct because the header carries it — if this
    // assertion ever goes, the removal above stops being a fair trade.
    const response = await blockedResponse();
    const retryAfter = response.headers.get('Retry-After');

    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  });
});
