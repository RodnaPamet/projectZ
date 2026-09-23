import { timingSafeEqual } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { releaseExpiredBookings } from '@/app-layer/usecases/release-expired-bookings';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

/**
 * Release slots held by checkouts nobody finished.
 *
 * ═══ THIS SECRET IS THE ONLY THING GUARDING THIS ROUTE ═══
 *
 * Not a belt-and-braces check on top of the platform's. Verified, not assumed:
 *
 *   - `checkTenantAccess` returns `{ kind: 'allow' }` for ANY path with no
 *     tenant slug (guard.ts), so the middleware waves this through
 *     unauthenticated;
 *   - `requiredPermission` only has rules under `/api/(vN/)?t/`, and returns
 *     null for everything else, which middleware reads as "no permission
 *     required";
 *   - `route-permission-coverage` only inspects routes under that same
 *     prefix, so it will never complain that this one is ungated.
 *
 * Three layers that each decline to cover this path. Whatever is written below
 * is the entire security boundary of an endpoint that cancels bookings across
 * every tenant.
 *
 * ═══ SO IT FAILS CLOSED, AND COMPARES IN CONSTANT TIME ═══
 *
 * A missing `CRON_SECRET` returns 503, never "unset means allow". That
 * inversion — no credential configured, therefore no check — is how an
 * internal endpoint ends up open on the day someone forgets an env var, and
 * it is the most common way this shape of route goes wrong.
 *
 * `timingSafeEqual` rather than `===`, because a string compare returns early
 * on the first differing byte and leaks the secret a character at a time to
 * anyone patient enough to measure. It throws on a length mismatch, so the
 * lengths are compared first — and that comparison is itself a disclosure of
 * the secret's LENGTH, which is a cost worth naming and accepting.
 */
function authorised(req: NextRequest): { ok: true } | { ok: false; status: number } {
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    logger.error('CRON_SECRET is not set; refusing to run the sweep', { component: 'cron' });
    return { ok: false, status: 503 };
  }

  // Vercel Cron sends `Authorization: Bearer <secret>`; a manual call or
  // another scheduler may use the header directly. Both are accepted so the
  // deployment is not locked to one provider.
  const header =
    req.headers.get('x-cron-secret') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';

  const a = Buffer.from(header);
  const b = Buffer.from(expected);

  if (a.length !== b.length) return { ok: false, status: 401 };
  if (!timingSafeEqual(a, b)) return { ok: false, status: 401 };

  return { ok: true };
}

export async function POST(req: NextRequest) {
  const auth = authorised(req);

  if (!auth.ok) {
    // Deliberately no detail. "Wrong secret" and "no secret configured" look
    // identical to a caller; the operator finds the difference in the log.
    //
    // The canonical envelope, even here — a scheduler is a client too, and the
    // `api-error-envelope` guardrail exists because this file's neighbours once
    // answered with a bare string where every other route answers with a
    // struct.
    return NextResponse.json(
      {
        error: {
          code: auth.status === 503 ? 'NOT_CONFIGURED' : 'UNAUTHORIZED',
          message: auth.status === 503 ? 'Scheduled sweep is not configured' : 'Unauthorized',
        },
      },
      { status: auth.status },
    );
  }

  // Cross-tenant by nature: a sweep runs for the whole platform and has no
  // session to bind to.
  const result = await runAsSuperuser((db) => releaseExpiredBookings(db));

  if (result.released > 0 || result.truncated) {
    logger.info('released expired bookings', {
      component: 'cron',
      scanned: result.scanned,
      released: result.released,
      truncated: result.truncated,
    });
  }

  return NextResponse.json(result);
}
