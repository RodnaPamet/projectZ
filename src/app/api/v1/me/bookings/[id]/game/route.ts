import { type NextRequest } from 'next/server';

import { openGameBodySchema } from '@/app-layer/schemas/open-play';
import { closeGame, getBookingGame, openGame } from '@/app-layer/usecases/open-play';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toBookingGameDto } from '@/app/api/v1/_lib/open-play-dto';
import { NotFoundError, UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/me/bookings/{id}/game — open play on a booking (#376). The
 * booker gets whether they can open it, the game, and every request with the
 * asker's public card; a player on it gets the game and their own request.
 * 404 for a booking the caller is not on.
 */
async function getHandler(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const view = await getBookingGame({ userId: ctx.userId, bookingId: id });
  if (!view) throw new NotFoundError('Booking not found');
  return ok(toBookingGameDto(view));
}

/**
 * PUT /api/v1/me/bookings/{id}/game — the booker opens the booking to other
 * players, changes what it asks for, or reopens it. Body `{ spots, levelMin?,
 * levelMax?, note? }`: `spots` more players wanted now, at most the court's
 * free places. 403 BOOKER_ONLY; 409 GAME_NOT_OPENABLE, OPEN_PLAY_CUTOFF_PASSED,
 * SPOTS_UNAVAILABLE, BOOKING_FULL.
 */
async function putHandler(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const body = await parseJsonBody(req, openGameBodySchema, 'game');
  const view = await openGame({ userId: ctx.userId, bookingId: id, ...body });
  return ok(toBookingGameDto(view));
}

/**
 * DELETE /api/v1/me/bookings/{id}/game — the booker stops looking for
 * players. Waiting requests close and their askers are told; accepted players
 * stay. Idempotent. Answers the booking's game, as GET does.
 */
async function deleteHandler(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const view = await closeGame({ userId: ctx.userId, bookingId: id });
  return ok(toBookingGameDto(view));
}

export const GET = defineV1Route(getHandler);
export const PUT = defineV1Route(putHandler);
export const DELETE = defineV1Route(deleteHandler);
