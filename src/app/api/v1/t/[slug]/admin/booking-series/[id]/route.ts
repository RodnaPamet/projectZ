import { type NextRequest } from 'next/server';

import { moveSeriesBodySchema } from '@/app-layer/schemas/desk';
import { notifySeriesMoved } from '@/app-layer/usecases/booking-notifications';
import { getSeries, moveSeriesFrom } from '@/app-layer/usecases/desk-bookings';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { parseDeskBody, requireDesk } from '@/app/api/v1/_lib/desk';
import { toBookingSeries } from '@/app/api/v1/_lib/desk-dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/** A weekly series and every occurrence, cancelled ones included (#364). */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);

  const row = await inTenant(ctx, (db) => getSeries(db, ctx.tenantId, id));
  // Another club's series is invisible under RLS: the same 404 as none.
  if (!row) throw new NotFoundError('Series not found');
  return ok(toBookingSeries(row));
}

export const GET = defineV1Route(handler);

/**
 * PATCH: move the series from a date on to a new time, length or court
 * (#415). Every moved week is checked first; any clash refuses the whole move
 * with the dates (`SeriesClashError`, 409). A move from a later week splits
 * the series, and the answer is the series the moved weeks now belong to. A
 * linked player is told once.
 */
async function move(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const body = await parseDeskBody(req, moveSeriesBodySchema);

  const result = await inTenant(
    ctx,
    async (db) => {
      const moved = await moveSeriesFrom(
        db,
        { tenantId: ctx.tenantId, actorUserId: ctx.userId },
        id,
        body,
      );
      if (!moved) throw new NotFoundError('Series or court not found');
      return { ...moved, row: await getSeries(db, ctx.tenantId, moved.seriesId) };
    },
    { isolationLevel: 'Serializable' },
  );
  if (!result.row) throw new NotFoundError('Series not found');

  await notifySeriesMoved({
    tenantId: ctx.tenantId,
    seriesId: result.seriesId,
    fromDate: body.fromDate,
  });
  return ok({ ...toBookingSeries(result.row), moved: result.moved, split: result.split });
}

export const PATCH = defineV1Route(move);
