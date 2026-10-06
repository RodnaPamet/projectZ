import { timingSafeEqual } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { sendBookingReminders } from '@/app-layer/usecases/booking-notifications';
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
 * The 3-hour reminder (#367, Q22), every 5 minutes.
 *
 * Claims each CONFIRMED booking that starts in 2–3 hours and has not been
 * reminded, then writes the bell row and the reminder email for everyone on
 * it — see `sendBookingReminders` for why that is exactly once, and why the
 * DST change does not move it. It then drains the outbox once, so the email
 * leaves within this run rather than a minute later.
 *
 * The binding is the use case's: both use cases bind BYPASSRLS themselves
 * (machine work across every club, with no session), and this route touches
 * the database through nothing else.
 */
export async function POST(req: NextRequest) {
  const refusal = refused(req, 'send-booking-reminders');
  if (refusal) return refusal;

  const reminders = await sendBookingReminders();
  const drained = reminders.claimed > 0 ? await drainEmailOutbox() : null;

  if (reminders.claimed > 0) {
    logger.info('booking reminders', {
      component: 'cron',
      claimed: reminders.claimed,
      notified: reminders.notified,
      sent: drained?.sent ?? 0,
    });
  }
  return NextResponse.json({ ...reminders, drained });
}
