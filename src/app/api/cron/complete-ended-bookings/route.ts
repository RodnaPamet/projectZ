import { timingSafeEqual } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { completeEndedBookings } from '@/app-layer/usecases/booking-outcome';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { logger } from '@/lib/observability/logger';

/**
 * Mark CONFIRMED bookings COMPLETED once their end time has passed.
 *
 * ═══ WHY IT IS A JOB AND NOT A READ-TIME RULE ═══
 *
 * "Ended and confirmed means played" could be computed wherever it is needed.
 * It is written down instead, because two things need it to be a FACT rather
 * than an inference: a review's proof of visit is `status = 'COMPLETED'`, and
 * staff overturn the presumption by moving the booking to NO_SHOW. A status
 * that only existed at read time would have nothing for staff to overturn.
 *
 * ═══ THIS SECRET IS THE ONLY THING GUARDING THIS ROUTE ═══
 *
 * The same three layers decline to cover it as for release-expired-bookings,
 * for the same verified reasons: `checkTenantAccess` allows any path with no
 * tenant slug, `requiredPermission` only has rules under `/api/(vN/)?t/`, and
 * `route-permission-coverage` only inspects that prefix. What is below is the
 * whole security boundary of an endpoint that writes every club's bookings.
 *
 * So it fails CLOSED — no `CRON_SECRET`, 503 — and compares in constant time.
 * `timingSafeEqual` throws on a length mismatch, so the lengths are compared
 * first, which discloses the secret's LENGTH; a cost worth naming and accepting.
 */
function authorised(req: NextRequest): { ok: true } | { ok: false; status: number } {
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    logger.error('CRON_SECRET is not set; refusing to run the completion sweep', {
      component: 'cron',
    });
    return { ok: false, status: 503 };
  }

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
    // No detail: "wrong secret" and "no secret configured" look the same from
    // outside, and the operator finds the difference in the log.
    return NextResponse.json(
      {
        error: {
          code: auth.status === 503 ? 'NOT_CONFIGURED' : 'UNAUTHORIZED',
          message: auth.status === 503 ? 'Completion sweep is not configured' : 'Unauthorized',
        },
      },
      { status: auth.status },
    );
  }

  // Cross-tenant by nature, and machine work with no human actor — which is why
  // this is runAsSuperuser and not asPlatformAdmin: there is no grant to audit
  // it against. Every row it writes is audited as SYSTEM instead.
  const result = await runAsSuperuser((db) => completeEndedBookings(db));

  if (result.completed > 0 || result.truncated || result.feeLines > 0) {
    logger.info('completed ended bookings', {
      component: 'cron',
      scanned: result.scanned,
      completed: result.completed,
      truncated: result.truncated,
      feeLines: result.feeLines,
    });
  }

  return NextResponse.json(result);
}
