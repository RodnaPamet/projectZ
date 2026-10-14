import { type NextRequest } from 'next/server';

import { tournamentBodySchema } from '@/app-layer/schemas/tournaments';
import { createTournament, listClubTournaments } from '@/app-layer/usecases/club-tournaments';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { requireDesk } from '@/app/api/v1/_lib/desk';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toTournamentDto } from '@/app/api/v1/_lib/tournament-dto';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/t/{slug}/admin/tournaments (#579): the club's tournaments, the
 * latest first. Needs `bookings.view_all`: the desk runs them too (52).
 */
async function getHandler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const items = await listClubTournaments(ctx.tenantId);
  return ok({ items: items.map(toTournamentDto) });
}

/**
 * POST /api/v1/t/{slug}/admin/tournaments (#579): the club creates a
 * tournament, in DRAFT; `POST …/{id}/open` opens sign-up.
 *
 * 400 TOURNAMENT_INVALID (`details.field`); 409 TOURNAMENT_ONLINE_FEE_UNAVAILABLE
 * until online fees ship (#581).
 */
async function postHandler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const body = await parseJsonBody(req, tournamentBodySchema, 'tournament');
  const { id } = await createTournament({ userId: ctx.userId, tenantId: ctx.tenantId }, body);
  return ok({ id }, { status: 201 });
}

export const GET = defineV1Route(getHandler);
export const POST = defineV1Route(postHandler);
