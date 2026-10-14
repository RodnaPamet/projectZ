import { type NextRequest } from 'next/server';

import { answerMatchTime } from '@/app-layer/usecases/league-proposals';
import { readDraw } from '@/app-layer/usecases/tournament-draw';
import { notifyMatchScheduled } from '@/app-layer/usecases/tournament-notifications';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toDrawDto } from '@/app/api/v1/_lib/tournament-dto';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/tournament-matches/{id}/proposal/accept (#591, 63): someone
 * on the other side accepts the proposed time. The booking is confirmed and
 * everyone on the match is told, as when the club places it.
 *
 * 404 TOURNAMENT_MATCH_NOT_FOUND; 409 TOURNAMENT_NO_PROPOSAL (none, or the
 * caller's own side proposed it).
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const { tournamentId } = await answerMatchTime({ userId: ctx.userId }, id, true);
  await notifyMatchScheduled(id);
  const draw = await readDraw(tournamentId, ctx.userId);
  return ok(toDrawDto(draw!));
}

export const POST = defineV1Route(handler);
