import { type NextRequest } from 'next/server';

import { answerMatchTime, proposeMatchTime } from '@/app-layer/usecases/league-proposals';
import { proposeMatchBodySchema } from '@/app-layer/schemas/tournaments';
import { readDraw } from '@/app-layer/usecases/tournament-draw';
import {
  notifyMatchProposed,
  notifyProposalLetGo,
} from '@/app-layer/usecases/tournament-notifications';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toDrawDto } from '@/app/api/v1/_lib/tournament-dto';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/me/tournament-matches/{id}/proposal (#591; decisions 62, 63):
 * a player on a ready league match proposes `{ resourceId, startTs,
 * durationMinutes }`. The court is held in their name at its own price, paid
 * at the club, until the other side answers; the other side is told.
 *
 * 400 TOURNAMENT_INVALID, SLOT_NOT_BOOKABLE; 404 TOURNAMENT_MATCH_NOT_FOUND
 * (not the caller's match); 409 TOURNAMENT_MATCH_NOT_READY,
 * TOURNAMENT_MATCH_PLACED, SLOT_TAKEN; 429 RATE_LIMITED.
 */
async function postHandler(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const body = await parseJsonBody(req, proposeMatchBodySchema, 'proposal');
  const { tournamentId } = await proposeMatchTime({ userId: ctx.userId }, id, body);
  await notifyMatchProposed(id);
  const draw = await readDraw(tournamentId, ctx.userId);
  return ok(toDrawDto(draw!), { status: 201 });
}

/**
 * DELETE /api/v1/me/tournament-matches/{id}/proposal (#591, 63): the other
 * side declines the proposed time, or the proposer takes it back. The held
 * court is released, and the other side is told.
 *
 * 404 TOURNAMENT_MATCH_NOT_FOUND; 409 TOURNAMENT_NO_PROPOSAL.
 */
async function deleteHandler(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const { tournamentId, bookingId, answer } = await answerMatchTime(
    { userId: ctx.userId },
    id,
    false,
  );
  await notifyProposalLetGo(id, bookingId, ctx.userId, answer);
  const draw = await readDraw(tournamentId, ctx.userId);
  return ok(toDrawDto(draw!));
}

export const POST = defineV1Route(postHandler);
export const DELETE = defineV1Route(deleteHandler);
