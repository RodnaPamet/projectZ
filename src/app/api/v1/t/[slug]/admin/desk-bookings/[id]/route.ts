import { type NextRequest } from 'next/server';

import { updateDeskBookingBodySchema } from '@/app-layer/schemas/desk';
import { getDeskBooking, updateDeskBooking } from '@/app-layer/usecases/desk-bookings';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { parseDeskBody, requireDesk } from '@/app/api/v1/_lib/desk';
import { toDeskBooking } from '@/app/api/v1/_lib/desk-dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * One desk booking (#364): read it, or change its customer or notes.
 *
 * An id that is not a DESK booking at this club is 404 on GET — another club's
 * booking and an online booking here look the same. A PATCH of an online
 * booking here is 409 NOT_A_DESK_BOOKING; of a cancelled, played or no-show
 * one, 409 BOOKING_NOT_EDITABLE. Cancelling is the ordinary
 * `POST /t/{slug}/bookings/{id}/cancel`, which staff may always use.
 */
type Params = { params: Promise<{ slug: string; id: string }> };

async function getHandler(req: NextRequest, { params }: Params) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);

  const row = await inTenant(ctx, (db) => getDeskBooking(db, ctx.tenantId, id));
  if (!row) throw new NotFoundError('Booking not found');
  return ok(toDeskBooking(row));
}

async function patchHandler(req: NextRequest, { params }: Params) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);

  const body = await parseDeskBody(req, updateDeskBookingBodySchema);

  const row = await inTenant(ctx, async (db) => {
    const found = await updateDeskBooking(
      db,
      { tenantId: ctx.tenantId, actorUserId: ctx.userId },
      id,
      body,
    );
    return found ? getDeskBooking(db, ctx.tenantId, id) : null;
  });

  if (!row) throw new NotFoundError('Booking not found');
  return ok(toDeskBooking(row));
}

export const GET = defineV1Route(getHandler);
export const PATCH = defineV1Route(patchHandler);
