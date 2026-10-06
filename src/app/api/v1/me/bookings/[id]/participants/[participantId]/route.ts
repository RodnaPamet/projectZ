import { type NextRequest } from 'next/server';

import { removeBookingPlayer } from '@/app-layer/usecases/booking-players';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { noContent } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * DELETE /api/v1/me/bookings/{id}/participants/{participantId} — the booker
 * takes a player off their booking (#358). Audited
 * (BOOKING_PLAYER_REMOVED), in the booking's club.
 *
 * 204. 403 BOOKER_ONLY for an added player (they leave with
 * `DELETE …/participation` instead), 404 for a booking the caller is not on
 * or a participant id not on it, 409 BOOKING_PLAYERS_CLOSED once it started.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; participantId: string }> },
) {
  const { id, participantId } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  await removeBookingPlayer({ userId: ctx.userId, bookingId: id, participantId });
  return noContent();
}

export const DELETE = defineV1Route(handler);
