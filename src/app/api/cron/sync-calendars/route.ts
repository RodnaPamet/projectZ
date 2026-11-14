import { timingSafeEqual } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { syncDueCalendars } from '@/app-layer/usecases/google-calendar-sync';
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
 * Keep players' Google Calendars current (owner 2026-11-14), every 5 minutes.
 *
 * Syncs every connection the database marked dirty (P88's triggers, when
 * something on that person's schedule changed), then every connection not
 * synced for six hours; at most 50 per run, the rest next run. With
 * `GOOGLE_CALENDAR_SYNC` off it answers zeros and touches nothing.
 *
 * The binding is the use case's (`runAsSuperuser` for the loop's reads, a
 * timer with no session); this route touches the database through nothing else.
 */
export async function POST(req: NextRequest) {
  const refusal = refused(req, 'sync-calendars');
  if (refusal) return refusal;

  const result = await syncDueCalendars();
  if (result.synced + result.failed + result.revoked > 0) {
    logger.info('calendars synced', { component: 'cron', ...result });
  }
  return NextResponse.json(result);
}
