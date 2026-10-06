import { type NextRequest } from 'next/server';

import { leaveBooking } from '@/app-layer/usecases/booking-players';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { noContent } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * DELETE /api/v1/me/bookings/{id}/participation — the caller leaves a booking
 * they were added to (#358). The booking stays the booker's and the court
 * stays booked; only the caller's place frees up.
 *
 * 204. 409 BOOKER_CANNOT_LEAVE for the booker, who cancels instead; 404 for a
 * booking the caller is not on; 409 BOOKING_PLAYERS_CLOSED once it started.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  await leaveBooking({ userId: ctx.userId, bookingId: id });
  return noContent();
}

export const DELETE = defineV1Route(handler);
