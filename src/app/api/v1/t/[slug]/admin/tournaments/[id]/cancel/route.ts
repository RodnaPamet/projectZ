import { type NextRequest } from 'next/server';

import { cancelTournament, getClubTournament } from '@/app-layer/usecases/club-tournaments';
import { notifyTournamentCancelled } from '@/app-layer/usecases/tournament-notifications';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { requireDesk } from '@/app/api/v1/_lib/desk';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toClubTournamentDto } from '@/app/api/v1/_lib/tournament-dto';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/t/{slug}/admin/tournaments/{id}/cancel (#579): the club
 * cancels a tournament that is not over; every live entry's players are told.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const { entryIds } = await cancelTournament({ userId: ctx.userId, tenantId: ctx.tenantId }, id);
  await notifyTournamentCancelled(entryIds);
  const t = await getClubTournament(ctx.tenantId, id);
  return ok(toClubTournamentDto(t!));
}

export const POST = defineV1Route(handler);
