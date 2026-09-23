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
 * `cancelBooking` writes a Cancellation row every time it is called and
 * recomputes the refund from the CURRENT hours-until-start. Calling it twice
 * therefore produces two receipts for one booking, the second quoting a
 * smaller refund — a double refund record, and an audit trail that disagrees
 * with itself.
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
