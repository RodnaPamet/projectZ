import { timingSafeEqual } from 'node:crypto';

import { type NextRequest, NextResponse } from 'next/server';

import { sweepOrphanMedia } from '@/app-layer/usecases/venue-photos';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { getMediaStorage } from '@/lib/media/storage';
import { logger } from '@/lib/observability/logger';

/**
 * Delete venue-photo objects that no `venue_photo` row names (#366), once a
 * day (`ops/sweep.compose.yml`, `media-sweep`).
 *
 * ═══ WHAT LEAVES AN ORPHAN ═══
 *
 *   - a photo or cover removed while storage was unreachable: the row went,
 *     the delete after the commit failed and was logged;
 *   - a venue or a club removed: `venue_photo` cascades with the venue, and
 *     nothing else knows its objects;
 *   - an upload whose process died between the objects and the row.
 *
 * Only objects older than a day are touched, so an upload in flight (objects
 * written, row not yet committed) is never mistaken for one. Rows are read
 * BYPASSRLS because the sweep spans every club, and only `objectKey`.
 *
 * Guarded exactly as the other cron routes: CRON_SECRET, fail closed (503
 * when unset), compared in constant time. With media storage not configured
 * it answers 200 with nothing scanned.
 */
function authorised(req: NextRequest): { ok: true } | { ok: false; status: number } {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    logger.error('CRON_SECRET is not set; refusing to run the media sweep', {
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
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, status: 401 };
  return { ok: true };
}

export async function POST(req: NextRequest) {
  const auth = authorised(req);
  if (!auth.ok) {
    return NextResponse.json(
      {
        error: {
          code: auth.status === 503 ? 'NOT_CONFIGURED' : 'UNAUTHORIZED',
          message: auth.status === 503 ? 'Media sweep is not configured' : 'Unauthorized',
        },
      },
      { status: auth.status },
    );
  }

  const storage = getMediaStorage();
  if (!storage) return NextResponse.json({ scanned: 0, deleted: 0, truncated: false });

  // Machine work with no human actor, across every club: runAsSuperuser, as
  // the other sweeps. It reads `venue_photo.objectKey` and writes nothing.
  const result = await runAsSuperuser((db) => sweepOrphanMedia(db, storage));

  if (result.deleted > 0 || result.truncated) {
    logger.info('swept orphaned venue photo objects', { component: 'cron', ...result });
  }
  return NextResponse.json(result);
}
