import { type NextRequest } from 'next/server';

import { answerRequest } from '@/app-layer/usecases/open-play';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toBookingGameDto } from '@/app/api/v1/_lib/open-play-dto';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/bookings/{id}/game/requests/{requestId}/accept — the booker
 * accepts a request (#376): the player is put on the booking and told.
 * Repeating it is a 200. 409 GAME_FULL, REQUEST_NOT_PENDING,
 * OPEN_PLAY_CUTOFF_PASSED; 404 REQUEST_NOT_FOUND.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; requestId: string }> },
) {
  const { id, requestId } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const view = await answerRequest({
    userId: ctx.userId,
    bookingId: id,
    requestId,
    decision: 'accept',
  });
  return ok(toBookingGameDto(view));
}

export const POST = defineV1Route(handler);
