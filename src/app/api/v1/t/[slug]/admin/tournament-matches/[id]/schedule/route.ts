import { type NextRequest } from 'next/server';

import { scheduleMatchBodySchema } from '@/app-layer/schemas/tournaments';
import { readDraw, scheduleMatch } from '@/app-layer/usecases/tournament-draw';
import { notifyMatchScheduled } from '@/app-layer/usecases/tournament-notifications';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { requireDesk } from '@/app/api/v1/_lib/desk';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toDrawDto } from '@/app/api/v1/_lib/tournament-dto';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/t/{slug}/admin/tournament-matches/{id}/schedule (#580, decision
 * 40): the club puts a ready match on a court and time, `{ resourceId,
 * startTs, durationMinutes }`. It is a booking on the diary with the match's
 * players on it, and their result is the match's. A match already on a court
 * moves. Its players are told.
 *
 * 400 TOURNAMENT_INVALID; 404 TOURNAMENT_MATCH_NOT_FOUND; 409
 * TOURNAMENT_MATCH_NOT_READY, SLOT_TAKEN.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const body = await parseJsonBody(req, scheduleMatchBodySchema, 'schedule');
  const { tournamentId } = await scheduleMatch(
    { userId: ctx.userId, tenantId: ctx.tenantId },
    id,
    body,
  );
  await notifyMatchScheduled(id);
  const draw = await readDraw(tournamentId, ctx.userId, { tenantId: ctx.tenantId });
  return ok(toDrawDto(draw!));
}

export const POST = defineV1Route(handler);
