import { type NextRequest } from 'next/server';

import { getOpenGame } from '@/app-layer/usecases/open-play';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toOpenGameDto } from '@/app/api/v1/_lib/open-play-dto';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/games/{id} — one open game (#376). Anyone sees a listed game; a
 * signed-in player also sees one they asked to join or play in after it
 * stopped being listed. 404 otherwise.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const game = await getOpenGame(id, { viewerId: ctx.userId ?? null });
  if (!game) throw new NotFoundError('Game not found');
  return ok(toOpenGameDto(game));
}

export const GET = defineV1Route(handler);
