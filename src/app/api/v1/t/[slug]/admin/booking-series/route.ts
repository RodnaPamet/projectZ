import { type NextRequest } from 'next/server';

import { createSeriesBodySchema } from '@/app-layer/schemas/desk';
import { SlotTakenError } from '@/app-layer/usecases/booking';
import {
  createSeries,
  getSeries,
  SeriesClashError,
  seriesClashes,
} from '@/app-layer/usecases/desk-bookings';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { parseDeskBody, requireDesk, requireIdempotencyKey } from '@/app/api/v1/_lib/desk';
import { toBookingSeries } from '@/app/api/v1/_lib/desk-dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * A weekly series for a regular customer (#364, Q41): the same court, weekday,
 * club-local time and length, for `repeat.weeks` weeks or until `repeat.until`,
 * minus `skipDates`. Each occurrence is an ordinary DESK booking.
 *
 * ═══ ALL OR NOTHING ═══
 *
 * Every occurrence is inserted in ONE transaction and the overlap constraint
 * arbitrates each. A week another booking holds — at preview time or taken
 * since — fails the whole request with 409 SERIES_CLASH and `details.clashes`
 * listing each week (`taken`, or `unavailable` for a closed day or a time the
 * clocks skip). Nothing is written. The desk skips those weeks and sends it
 * again, with a NEW `Idempotency-Key`: a key is spent only by a series that was
 * created, so reusing it after a 409 is harmless too.
 *
 * Two desks racing for the same weeks: one commits, the other gets the 409
 * with the weeks the winner took. Never half a series.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);

  const idempotencyKey = requireIdempotencyKey(req);
  const body = await parseDeskBody(req, createSeriesBodySchema);

  let result;
  try {
    result = await inTenant(ctx, async (db) => {
      const created = await createSeries(
        db,
        { tenantId: ctx.tenantId, actorUserId: ctx.userId, idempotencyKey },
        body,
      );
      if (!created) throw new NotFoundError('Resource not found');
      return { row: await getSeries(db, ctx.tenantId, created.seriesId), replay: created.replay };
    });
  } catch (err) {
    if (!(err instanceof SlotTakenError)) throw err;
    // The transaction that lost is aborted and rolled back; ask a fresh one
    // which weeks are now held. Empty means the winner has since been
    // cancelled: the ordinary SLOT_TAKEN, which the desk retries.
    const clashes = await inTenant(ctx, (db) => seriesClashes(db, ctx.tenantId, body));
    if (clashes.length === 0) throw err;
    throw new SeriesClashError(clashes);
  }

  if (!result.row) throw new NotFoundError('Series not found');
  return ok(toBookingSeries(result.row), { status: result.replay ? 200 : 201 });
}

export const POST = defineV1Route(handler);
