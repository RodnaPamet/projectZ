import { type NextRequest } from 'next/server';

import { askToJoinBodySchema } from '@/app-layer/schemas/open-play';
import { askToJoin } from '@/app-layer/usecases/open-play';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toOpenGameDto } from '@/app/api/v1/_lib/open-play-dto';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/games/{id}/requests — ask to join (#376). Body `{ note? }`.
 * Every join is a request the booker answers (owner decision 2026-10-13).
 * Answers the game with the caller's request in `viewer.request`; 201 for a
 * new request, 200 when one was already waiting. Rate limited per person.
 *
 * 409 GAME_CLOSED, GAME_FULL, OPEN_PLAY_CUTOFF_PASSED, ALREADY_PLAYING,
 * ASK_DECLINED; 403 PLAYER_ACCOUNT_REQUIRED, NO_SHOW_BLOCKED; 404 GAME_NOT_FOUND.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const body = await parseJsonBody(req, askToJoinBodySchema, 'request');
  const { game, created } = await askToJoin({ userId: ctx.userId, gameId: id, note: body.note });
  return ok(toOpenGameDto(game), { status: created ? 201 : 200 });
}

export const POST = defineV1Route(handler);
