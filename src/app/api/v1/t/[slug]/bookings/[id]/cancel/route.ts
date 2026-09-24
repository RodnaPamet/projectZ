import { type NextRequest } from 'next/server';

import { getBookingById, getOwnBooking } from '@/app-layer/repositories/booking';
import { cancelBooking } from '@/app-layer/usecases/booking';
import { hasPermission } from '@/app-layer/types';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { ConflictError, NotFoundError, UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * Cancel a booking, and quote the refund.
 *
 * ═══ THE PERMISSION IS NOT THE AUTHORISATION ═══
 *
 * ROUTE_PERMISSIONS gates this on `bookings.cancel`, which every PLAYER holds
 * — necessarily, since cancelling your own booking is an ordinary thing to do.
 * `cancelBooking` then loads the row by `{ id, tenantId }` and nothing else.
 *
 * Those two facts together mean the use case will happily cancel ANY booking
 * at the club for ANY member of it. The middleware cannot close that: it knows
 * the caller may cancel bookings, not whose. Ownership is a row-level
 * question, so it is answered here, where the row is.
 *
 * Staff holding `bookings.view_all` may cancel on a player's behalf — that is
 * the desk taking a phone call, and it is the reason the permission exists as
 * something distinct from `bookings.cancel`.
 *
 * ═══ ALREADY-CANCELLED IS A CONFLICT, NOT A NO-OP ═══
 *
 * The checks below are for the MESSAGE, not for the invariant. They can say
 * "already cancelled" or "a completed booking cannot be cancelled", which is
 * worth far more to a client than a generic conflict.
 *
 * What they are NOT is the thing preventing a double receipt. Two receipts are
 * unreachable because `Cancellation.bookingId` is @unique, and the race is
 * closed because `cancelBooking` carries the status in its UPDATE predicate
 * and writes nothing when it matches zero rows. A read in a route handler
 * cannot hold a row against a cron job; only the write can.
 *
 * So a booking that changes underneath us between here and there surfaces as
 * BookingNotCancellableError — the same 409, raised by the write that actually
 * arbitrates.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });

  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const asStaff = hasPermission(ctx, 'bookings.view_all');

  const result = await inTenant(ctx, async (db) => {
    const booking = asStaff
      ? await getBookingById(db, ctx.tenantId!, id)
      : await getOwnBooking(db, ctx.tenantId!, { bookingId: id, userId: ctx.userId! });

    // 404 rather than 403 for somebody else's booking. A 403 would confirm the
    // booking exists, which is enough to enumerate a club's reservations one
    // id at a time.
    if (!booking) throw new NotFoundError('Booking not found');

    if (booking.status === 'CANCELLED') {
      throw new ConflictError('This booking is already cancelled');
    }
    if (booking.status !== 'PENDING' && booking.status !== 'CONFIRMED') {
      throw new ConflictError(`A ${booking.status.toLowerCase()} booking cannot be cancelled`);
    }

    const reason = await req
      .json()
      .then((b: { reason?: unknown }) => (typeof b?.reason === 'string' ? b.reason : undefined))
      // A cancellation with no body is the common case — the player just taps
      // "cancel". Requiring JSON for that would be ceremony.
      .catch(() => undefined);

    return cancelBooking(db, ctx.tenantId!, {
      bookingId: booking.id,
      cancelledByUserId: ctx.userId,
      reason,
    });
  });

  return ok(result);
}

export const POST = defineV1Route(handler);
