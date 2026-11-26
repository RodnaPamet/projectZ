import { timingSafeEqual } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { sweepRetention } from '@/app-layer/usecases/retention-sweep';
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
 * The privacy policy's retention periods (#717), once a day
 * (`ops/sweep.compose.yml`, `retention-sweep`): bookings anonymised 5 years
 * after they ended, the club's history and moderation records after 5 years,
 * accepted texts 5 years after an account's deletion, "For clubs" enquiries 2
 * years after the last contact, the team's second-factor log after 1 year,
 * session records 90 days after they ended. The answer counts each category.
 *
 * The binding is the use case's (`runAsSuperuser`, machine work with no
 * session, each batch its own transaction); this route touches the database
 * through nothing else.
 */
export async function POST(req: NextRequest) {
  const refusal = refused(req, 'sweep-retention');
  if (refusal) return refusal;

  const result = await sweepRetention();
  if (result.total > 0 || result.truncated) {
    logger.info('retention sweep', { component: 'cron', ...result });
  }
  return NextResponse.json(result);
}
