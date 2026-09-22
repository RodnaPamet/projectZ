import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

import { collectMetrics, contentType } from '@/lib/observability/prometheus';

/**
 * The Prometheus scrape endpoint.
 *
 * ═══ THIS IS NOT PUBLIC ═══
 *
 * A metrics endpoint is an intelligence briefing on the business and on the
 * infrastructure. Left open it tells anybody who asks:
 *
 *   • exactly how many bookings we take, by sport, in real time — our revenue,
 *     our growth rate, and our seasonality, handed to a competitor for free;
 *   • our payment failure rate, which is a gift to anyone writing a story;
 *   • our route list, our queue names, our Node version, our memory ceiling and
 *     our event-loop lag — a map for anyone probing us.
 *
 * It is also a DoS surface: a scrape serialises every series in the registry, so
 * an unauthenticated endpoint that does real work is an unauthenticated endpoint
 * somebody will hammer.
 *
 * So it requires a bearer token. In a cluster you would ALSO bind it to the
 * internal network — belt and braces, because a token in a config map is a token
 * that leaks eventually.
 *
 * A ratchet (tests/guardrails/health-checks.test.ts) fails the build if this
 * route stops checking the token.
 */

export const dynamic = 'force-dynamic';

/**
 * Constant-time compare.
 *
 * `a === b` on a secret leaks its length and its prefix through timing. That is
 * a real attack on a token you can guess a character at a time, and the fix
 * costs one function call.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);

  // timingSafeEqual THROWS on a length mismatch, which would itself leak the
  // length. Compare lengths first, and always run the comparison.
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/**
 * The ONE closed response.
 *
 * Both closed paths — no token configured, and a wrong token — must be
 * byte-identical. They were not: the two 404s carried different bodies, which
 * tells an unauthenticated scanner exactly what the 404 exists to withhold,
 * namely that this endpoint is real and currently switched off.
 *
 * A shared helper rather than two literals, so the next edit cannot
 * reintroduce the difference by touching only one of them.
 */
function closed() {
  return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Not Found' } }, { status: 404 });
}

export async function GET(req: NextRequest) {
  const expected = process.env.METRICS_TOKEN;

  // No token configured → the endpoint is CLOSED, not open.
  //
  // Failing open here would mean that forgetting an environment variable in
  // production silently publishes the metrics. The failure mode of a missing
  // secret must never be "no security".
  if (!expected) {
    return closed();
  }

  const header = req.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!provided || !tokenMatches(provided, expected)) {
    // 404, not 401. A 401 confirms the endpoint EXISTS and is worth attacking;
    // a 404 tells an unauthenticated scanner nothing.
    return closed();
  }

  const body = await collectMetrics();

  return new NextResponse(body, {
    status: 200,
    headers: {
      'content-type': contentType,
      'cache-control': 'no-store',
    },
  });
}
