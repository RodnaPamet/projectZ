import { timingSafeEqual } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { sendSportFacts } from '@/app-layer/usecases/sport-facts';
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
 * «Факт на седмицата» (owner 2026-11-13): this week's fact about each
 * player's main sport, pushed on Monday from 10:00 Sofia time.
 *
 * The loop in ops/sweep.compose.yml calls this every 15 minutes rather than
 * once on Monday at 10:00: the use case answers `waiting: "not-monday"` or
 * `"before-send-hour"` until then, sends from the first run after it, and its
 * dedupe key (the ISO week of the Sofia Monday) makes every later run that
 * week a no-op. So no clock in the container has to know about Sofia or DST,
 * and a restart cannot send a week twice.
 *
 * The binding is the use case's: it reads BYPASSRLS itself and writes each
 * bell row bound to its recipient; this route touches the database through
 * nothing else.
 */
export async function POST(req: NextRequest) {
  const refusal = refused(req, 'send-sport-facts');
  if (refusal) return refusal;

  const run = await sendSportFacts();
  if (run.sent > 0 || run.truncated) {
    logger.info('sport facts', { component: 'cron', ...run });
  }
  return NextResponse.json(run);
}
