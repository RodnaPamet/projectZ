import { type NextRequest } from 'next/server';

import { walkoverBodySchema } from '@/app-layer/schemas/tournaments';
import { readDraw, recordWalkover } from '@/app-layer/usecases/tournament-draw';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { requireDesk } from '@/app/api/v1/_lib/desk';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toDrawDto } from '@/app/api/v1/_lib/tournament-dto';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/t/{slug}/admin/tournament-matches/{id}/walkover (#580;
 * decisions 58, 59): the club gives a ready match to `winnerSide` (0 or 1)
 * without it being played: unrated, the winner goes on, its court is freed.
 * In a league, `null` records a loss for both (#591, 58).
 *
 * 400 TOURNAMENT_INVALID (a loss for both outside a league);
 * 404 TOURNAMENT_MATCH_NOT_FOUND; 409 TOURNAMENT_MATCH_NOT_READY.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const body = await parseJsonBody(req, walkoverBodySchema, 'walkover');
  const { tournamentId } = await recordWalkover(
    { userId: ctx.userId, tenantId: ctx.tenantId },
    id,
    body.winnerSide,
  );
  const draw = await readDraw(tournamentId, ctx.userId, { tenantId: ctx.tenantId });
  return ok(toDrawDto(draw!));
}

export const POST = defineV1Route(handler);
