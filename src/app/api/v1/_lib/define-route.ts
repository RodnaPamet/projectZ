import { type NextRequest, NextResponse } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { getRequestId } from '@/lib/observability/context';
import { logger } from '@/lib/observability/logger';

import { toV1ErrorResponse } from './errors';

/**
 * How every v1 route is exported. There is no second way.
 *
 * ═══ WHY THE EXTRA CATCH ═══
 *
 * `withApiErrorHandling` converts errors itself, via a hardcoded
 * `toApiErrorResponse`. `ApiWrapperOptions` has exactly one field (`rateLimit`)
 * and offers no hook to substitute a mapper.
 *
 * All 27 domain errors extend plain `Error` rather than `AppError`, so that
 * hardcoded path turns every one of them into a 500 with "an unexpected
 * internal server error occurred". A player short on credit would be told the
 * server broke.
 *
 * Catching inside the wrapper is therefore the only way to get the v1 mapping.
 * The wrapper is still worth keeping underneath: it owns the request id, the
 * lifecycle logs and the span, and anything this catch misses still lands in
 * its own handler rather than escaping as a 500 with no log line.
 *
 * ═══ THE REQUEST ID IS THE WRAPPER'S, NOT A NEW ONE ═══
 *
 * `getRequestId()` reads the id the wrapper put into AsyncLocalStorage, which
 * is the same one it sets on `x-request-id` and writes to every log line.
 * Generating a fresh id here would mean the id in the error body did not match
 * the id in the logs — which is precisely when somebody needs them to match.
 *
 * ═══ WHY IT LOGS THE ERROR ITSELF ═══
 *
 * Catching here means the wrapper takes its SUCCESS path: it sees a returned
 * Response, logs `request completed` at info with a status and nothing else,
 * and its own catch — the only place that records the message, the span
 * exception, `recordRequestError` and Sentry — never runs.
 *
 * So EVERY v1 domain error was invisible in the logs beyond its status code.
 * A 403 read `{"status":403,"msg":"request completed"}`: no code, no reason, no
 * actor. That is the wrong shape for a 404 and an actively bad one for the
 * platform routes, whose 403 bodies deliberately withhold which capability was
 * missing on the stated grounds that the operator finds it in the log. Nothing
 * put it there, so somebody probing `/api/v1/platform/*` with a stolen session
 * was indistinguishable from ordinary traffic.
 *
 * WARN for 4xx, ERROR for 5xx. A refused request is not a server fault and
 * should not page anybody, but it must be searchable. The actor, tenant, route
 * and request id come from AsyncLocalStorage via the logger itself.
 *
 * The internal message is logged and NOT returned — that asymmetry is the whole
 * point of `clientMessage` in the error map.
 *
 * ═══ WHAT THIS CANNOT DO ═══
 *
 * Rate-limit a GET. `resolveRateLimitScope` returns null for any non-mutating
 * method BEFORE it reads the options, so `{ rateLimit: { config } }` on a read
 * route is silently ignored. The public reads are unauthenticated and
 * cross-tenant, which is exactly what wants a ceiling, so their protection is
 * the repository's own `clampLimit`/`MAX_RADIUS_KM` caps until the wrapper
 * grows read limiting.
 */
export function defineV1Route<Context = unknown>(
  handler: (req: NextRequest, ctx: Context) => Promise<NextResponse | Response>,
) {
  return withApiErrorHandling<Context>(async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (error) {
      const { payload, status } = toV1ErrorResponse(error, getRequestId());

      const detail = error instanceof Error ? error.message : String(error);
      const line = `v1 ${status} ${payload.error.code}`;
      const fields = { component: 'api', status, code: payload.error.code, error: detail };

      if (status >= 500) logger.error(line, fields);
      else logger.warn(line, fields);

      return NextResponse.json(payload, { status });
    }
  });
}
