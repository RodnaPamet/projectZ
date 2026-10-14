import { type NextRequest } from 'next/server';

import { getClubTournament, withdrawEntryAsClub } from '@/app-layer/usecases/club-tournaments';
import { notifyEntryWithdrawn } from '@/app-layer/usecases/tournament-notifications';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { requireDesk } from '@/app/api/v1/_lib/desk';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toClubTournamentDto } from '@/app/api/v1/_lib/tournament-dto';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/t/{slug}/admin/tournament-entries/{id}/withdraw (#580, decision
 * 59): the club withdraws a confirmed entry from a tournament under way: its
 * played results stand, its other matches are walkovers. Before the draw the
 * club declines an entry instead.
 *
 * 404 TOURNAMENT_ENTRY_NOT_FOUND; 409 TOURNAMENT_ENTRY_NOT_ACTIVE.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const { tournamentId } = await withdrawEntryAsClub(
    { userId: ctx.userId, tenantId: ctx.tenantId },
    id,
  );
  await notifyEntryWithdrawn(id, false);
  const t = await getClubTournament(ctx.tenantId, tournamentId);
  return ok(toClubTournamentDto(t!));
}

export const POST = defineV1Route(handler);
