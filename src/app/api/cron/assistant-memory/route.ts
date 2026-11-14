import { timingSafeEqual } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { runMemorySweep } from '@/app-layer/usecases/assistant-memory-sweep';
import { logger } from '@/lib/observability/logger';

/**
 * THIS SECRET IS THE ONLY THING GUARDING THIS ROUTE, as for the other cron
 * routes (see `complete-ended-bookings`). Fails CLOSED without `CRON_SECRET`
 * and compares in constant time.
 */
function refused(req: NextRequest): NextResponse | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    logger.error('CRON_SECRET is not set; refusing to run', {
      component: 'cron',
      job: 'assistant-memory',
    });
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
 * «Асистент»'s memory (owner 2026-11-14, #704), every 5 minutes: the
 * conversations quiet for ten minutes with questions not yet read; the points
 * the person said about themselves are learned into their profile. With the
 * assistant or its memory off it answers zeros and calls nobody.
 *
 * The binding is the use case's (`runAsSuperuser` for the queue of due
 * conversations, then `runAsUserOnly` as each person).
 */
export async function POST(req: NextRequest) {
  const refusal = refused(req);
  if (refusal) return refusal;
  const result = await runMemorySweep();
  if (result.read + result.skipped > 0)
    logger.info('assistant memory swept', { component: 'cron', ...result });
  return NextResponse.json(result);
}
