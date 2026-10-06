import { type NextRequest } from 'next/server';

import { getMyBooking } from '@/app-layer/usecases/my-bookings';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toMyBookingDetailDto } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError, UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/bookings/{id} — one of the caller's own bookings, in full
 * (#359): the venue's address and coordinates, how it is paid, who is on it,
 * and until when the player may cancel it.
 *
 * Club-free like `GET /me/bookings`: the booking may be at any club, and the
 * caller need not know which one to ask. The web's booking detail page renders
 * through the same use case and mapper.
 *
 * ═══ SOMEBODY ELSE'S BOOKING IS A 404, NOT A 403 ═══
 *
 * `getMyBooking` reads by `{ id, bookedByUserId }`, the user id from the
 * session, so another player's booking is never fetched at all. A 403 would
 * confirm the id exists; a 404 is the same answer an id that never existed
 * gets, so ids cannot be probed. The id is not validated as a cuid for the
 * same reason: a malformed id is just one more booking that is not yours.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const booking = await getMyBooking({ userId: ctx.userId, bookingId: id });
  if (!booking) throw new NotFoundError('Booking not found');

  return ok(toMyBookingDetailDto(booking));
}

export const GET = defineV1Route(handler);
