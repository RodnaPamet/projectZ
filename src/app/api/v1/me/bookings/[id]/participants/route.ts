import { type NextRequest } from 'next/server';

import { addParticipantBodySchema } from '@/app-layer/schemas/booking-players';
import { addCoPlayer, listBookingPlayers } from '@/app-layer/usecases/booking-players';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toBookingParticipantsDto } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError, UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/me/bookings/{id}/participants — who is playing (#358).
 *
 * For anyone ON the booking: its booker, or a player added to it. Names and
 * avatars only; no user ids, emails or phones, for anybody. A booking the
 * caller is not on is a 404, the answer an id that never existed gets, so a
 * stranger holding a booking id learns nothing (IDOR).
 */
async function getHandler(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const players = await listBookingPlayers({ userId: ctx.userId, bookingId: id });
  if (!players) throw new NotFoundError('Booking not found');
  return ok(toBookingParticipantsDto(players));
}

/**
 * POST /api/v1/me/bookings/{id}/participants — the booker adds somebody they
 * have played with (`GET …/co-players`). Body `{ userId }`, `.strict()`.
 *
 * Only a co-player can be added this way: any other user id is 404
 * PLAYER_NOT_FOUND, so nobody can be put on a booking by guessing an id.
 * Answers the participants list, as GET does.
 */
async function postHandler(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const body = await parseJsonBody(req, addParticipantBodySchema, 'participant');
  const added = await addCoPlayer({
    userId: ctx.userId,
    bookingId: id,
    playerUserId: body.userId,
  });

  const players = await listBookingPlayers({ userId: ctx.userId, bookingId: id });
  if (!players) throw new NotFoundError('Booking not found');
  return ok(toBookingParticipantsDto(players), { status: added.joined ? 201 : 200 });
}

export const GET = defineV1Route(getHandler);
export const POST = defineV1Route(postHandler);
