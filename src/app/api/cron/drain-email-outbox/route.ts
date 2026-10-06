import { timingSafeEqual } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { drainEmailOutbox } from '@/app-layer/usecases/notification-outbox';
import { logger } from '@/lib/observability/logger';

/**
 * THIS SECRET IS THE ONLY THING GUARDING THIS ROUTE, as for the other cron
 * routes (see `complete-ended-bookings`): no tenant slug, no permission rule.
 * So it fails CLOSED (no `CRON_SECRET`, 503) and compares in constant time;
 * the length check before `timingSafeEqual` discloses only the length.
 */
function refused(req: NextRequest, job: string): NextResponse | null {
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    logger.error('CRON_SECRET is not set; refusing to run', { component: 'cron', job });
    return NextResponse.json(
      { error: { code: 'NOT_CONFIGURED', message: 'This job is not configured' } },
      { status: 503 },
    );
  }

  const header =
    req.headers.get('x-cron-secret') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';
  const a = Buffer.from(header);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } },
      { status: 401 },
    );
  }
  return null;
}

/**
 * Send what is waiting in the email outbox (#367), every minute.
 *
 * One batch per call: claimed with `FOR UPDATE SKIP LOCKED` under a lease, so
 * overlapping calls never send a row twice. Failures are retried with backoff
 * and dead-lettered after `EMAIL_MAX_ATTEMPTS`. With no provider configured
 * (production today) the log-only adapter marks each row SENT by `log` and
 * nothing leaves the server; on staging that is forced.
 *
 * The binding is the use case's (`runAsSuperuser`, machine work with no
 * session); this route touches the database through nothing else.
 */
export async function POST(req: NextRequest) {
  const refusal = refused(req, 'drain-email-outbox');
  if (refusal) return refusal;

  const result = await drainEmailOutbox();
  if (result.claimed > 0) {
    logger.info('email outbox drained', { component: 'cron', ...result });
  }
  return NextResponse.json(result);
}
