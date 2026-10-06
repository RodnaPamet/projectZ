import { type NextRequest } from 'next/server';

import { createDeskBookingBodySchema } from '@/app-layer/schemas/desk';
import { createDeskBooking, getDeskBooking } from '@/app-layer/usecases/desk-bookings';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { parseDeskBody, requireDesk, requireIdempotencyKey } from '@/app/api/v1/_lib/desk';
import { toDeskBooking } from '@/app/api/v1/_lib/desk-dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * A booking entered at the club's desk (#364, Q30).
 *
 * Staff holding `bookings.view_all` book a court for a customer known by name
 * and phone, optionally linked to one of the club's players — which puts the
 * booking in that player's Резервации. `channel: DESK`: no online cap, no
 * no-show block, no "already started" refusal (a walk-in may be for the hour
 * under way), paid at the club, so CONFIRMED at once.
 *
 * The time is the club's wall clock (`date`, `startTime`, `durationMinutes`);
 * the server resolves it in the venue's timezone. The price is the server's
 * quote unless `priceCents` overrides it, and an override is audited
 * (DESK_PRICE_OVERRIDDEN, with both numbers).
 *
 * Not free → 409 SLOT_TAKEN, from the same EXCLUDE constraint an online
 * booking meets: a desk booking and an online one can never share a court.
 * The `Idempotency-Key` header is required, and a retry with the same key
 * returns the booking it made (200, not 201).
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);

  const idempotencyKey = requireIdempotencyKey(req);
  const body = await parseDeskBody(req, createDeskBookingBodySchema);

  const result = await inTenant(ctx, async (db) => {
    const created = await createDeskBooking(
      db,
      { tenantId: ctx.tenantId, actorUserId: ctx.userId, idempotencyKey },
      body,
    );
    // No such court at this club: the same 404 as another club's court.
    if (!created) throw new NotFoundError('Resource not found');
    const row = await getDeskBooking(db, ctx.tenantId, created.bookingId);
    return { row, replay: created.replay };
  });

  if (!result.row) throw new NotFoundError('Booking not found');
  return ok(toDeskBooking(result.row), { status: result.replay ? 200 : 201 });
}

export const POST = defineV1Route(handler);
