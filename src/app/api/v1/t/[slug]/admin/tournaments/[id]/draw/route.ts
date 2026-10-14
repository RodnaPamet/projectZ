import { type NextRequest } from 'next/server';

import { drawBodySchema } from '@/app-layer/schemas/tournaments';
import { drawTournament, readDraw } from '@/app-layer/usecases/tournament-draw';
import { notifyDrawMade } from '@/app-layer/usecases/tournament-notifications';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { requireDesk } from '@/app/api/v1/_lib/desk';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toDrawDto } from '@/app/api/v1/_lib/tournament-dto';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

type Params = { params: Promise<{ slug: string; id: string }> };

/**
 * GET /api/v1/t/{slug}/admin/tournaments/{id}/draw (#580): the draw as the
 * club runs it: groups with tables and matches, the knockout by round, the
 * match for third, each match with its court and time. 404 before the draw.
 */
async function getHandler(req: NextRequest, { params }: Params) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const draw = await readDraw(id, ctx.userId, { tenantId: ctx.tenantId });
  if (!draw) throw new NotFoundError('No draw yet');
  return ok(toDrawDto(draw));
}

/**
 * POST /api/v1/t/{slug}/admin/tournaments/{id}/draw (#580): the club makes the
 * draw, `{ groupCount?, qualifiersPerGroup?, thirdPlace? }` (55, 61); for
 * Americano and Mexicano `{ rounds, pointsPerMatch }` (56, 60); for a league
 * `{ divisions | divisionCount, firstDeadline, roundDays }` (44). The
 * confirmed entries are seeded by level (54); those still waiting are
 * declined. Everyone entered is told.
 *
 * 400 TOURNAMENT_INVALID; 409 TOURNAMENT_STATE, TOURNAMENT_TOO_FEW,
 * TOURNAMENT_DRAW_UNSUPPORTED.
 */
async function postHandler(req: NextRequest, { params }: Params) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const body = await parseJsonBody(req, drawBodySchema, 'draw');
  const { declined } = await drawTournament(
    { userId: ctx.userId, tenantId: ctx.tenantId },
    id,
    body,
  );
  await notifyDrawMade(id, declined);
  const draw = await readDraw(id, ctx.userId, { tenantId: ctx.tenantId });
  return ok(toDrawDto(draw!), { status: 201 });
}

export const GET = defineV1Route(getHandler);
export const POST = defineV1Route(postHandler);
