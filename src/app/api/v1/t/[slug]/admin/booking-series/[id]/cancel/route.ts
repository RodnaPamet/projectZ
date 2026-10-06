import { type NextRequest } from 'next/server';

import { cancelSeriesBodySchema } from '@/app-layer/schemas/desk';
import { cancelSeriesFrom, getSeries } from '@/app-layer/usecases/desk-bookings';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { parseDeskBody, requireDesk } from '@/app/api/v1/_lib/desk';
import { toBookingSeries } from '@/app/api/v1/_lib/desk-dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * "Cancel the rest of the series" (#364): every PENDING or CONFIRMED
 * occurrence starting on or after `fromDate` at the club. Each goes through the
 * ordinary staff cancel — its own receipt and BOOKING_CANCELLED audit row — and
 * the series gets BOOKING_SERIES_CANCELLED. Weeks already played or cancelled
 * are left as they are, so repeating the call is harmless.
 *
 * SERIALIZABLE, as the single cancel route: the cancel's wallet leg requires
 * it. Answers the series as it now is.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);

  const body = await parseDeskBody(req, cancelSeriesBodySchema);

  const row = await inTenant(
    ctx,
    async (db) => {
      const done = await cancelSeriesFrom(
        db,
        { tenantId: ctx.tenantId, actorUserId: ctx.userId },
        id,
        body,
      );
      return done ? getSeries(db, ctx.tenantId, id) : null;
    },
    { isolationLevel: 'Serializable' },
  );

  if (!row) throw new NotFoundError('Series not found');
  return ok(toBookingSeries(row));
}

export const POST = defineV1Route(handler);
