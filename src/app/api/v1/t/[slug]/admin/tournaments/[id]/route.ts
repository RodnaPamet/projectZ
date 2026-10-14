import { type NextRequest } from 'next/server';

import { tournamentBodySchema } from '@/app-layer/schemas/tournaments';
import { getClubTournament, updateTournament } from '@/app-layer/usecases/club-tournaments';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { requireDesk } from '@/app/api/v1/_lib/desk';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toClubTournamentDto } from '@/app/api/v1/_lib/tournament-dto';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

type Params = { params: Promise<{ slug: string; id: string }> };

/**
 * GET /api/v1/t/{slug}/admin/tournaments/{id} (#579): one of the club's
 * tournaments with every entry: confirmed, waiting (with its place on the
 * waiting list, 51), declined and withdrawn.
 */
async function getHandler(req: NextRequest, { params }: Params) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const t = await getClubTournament(ctx.tenantId, id);
  if (!t) throw new NotFoundError('Tournament not found');
  return ok(toClubTournamentDto(t));
}

/**
 * PUT /api/v1/t/{slug}/admin/tournaments/{id} (#579): the club changes a
 * tournament before it starts. Once there are entries, the format and team
 * size stay, and the draw cannot shrink below the confirmed entries.
 */
async function putHandler(req: NextRequest, { params }: Params) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const body = await parseJsonBody(req, tournamentBodySchema, 'tournament');
  await updateTournament({ userId: ctx.userId, tenantId: ctx.tenantId }, id, body);
  const t = await getClubTournament(ctx.tenantId, id);
  return ok(toClubTournamentDto(t!));
}

export const GET = defineV1Route(getHandler);
export const PUT = defineV1Route(putHandler);
