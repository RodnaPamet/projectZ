import { timingSafeEqual } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { reportDeadEmails } from '@/app-layer/usecases/dead-email-report';
import { logger } from '@/lib/observability/logger';

/**
 * POST /api/cron/report-dead-emails, daily (#425): tell the operator about
 * the emails that died in the last 24 hours. ops/sweep.compose.yml calls it
 * once a day with CRON_SECRET; a day with none sends nothing.
 */
function authorised(req: NextRequest): { ok: true } | { ok: false; status: number } {
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    logger.error('CRON_SECRET is not set; refusing to report dead emails', { component: 'cron' });
    return { ok: false, status: 503 };
  }

  const header =
    req.headers.get('x-cron-secret') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';

  const a = Buffer.from(header);
  const b = Buffer.from(expected);

  // Length first, because timingSafeEqual throws on a mismatch. That comparison
  // discloses the secret's LENGTH, which is a cost worth naming and accepting.
  if (a.length !== b.length) return { ok: false, status: 401 };
  if (!timingSafeEqual(a, b)) return { ok: false, status: 401 };

  return { ok: true };
}

export async function POST(req: NextRequest) {
  const auth = authorised(req);
  if (!auth.ok) {
    return NextResponse.json(
      {
        error: {
          code: auth.status === 503 ? 'NOT_CONFIGURED' : 'UNAUTHORIZED',
          message: auth.status === 503 ? 'Dead email report is not configured' : 'Unauthorized',
        },
      },
      { status: auth.status },
    );
  }

  const report = await reportDeadEmails();
  return NextResponse.json({
    dead: report.dead,
    sent: report.sent,
    truncated: report.truncated,
  });
}
