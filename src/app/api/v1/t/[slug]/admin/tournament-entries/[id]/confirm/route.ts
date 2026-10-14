import { type NextRequest } from 'next/server';

import { decideEntry, getClubTournament } from '@/app-layer/usecases/club-tournaments';
import { notifyEntryDecided } from '@/app-layer/usecases/tournament-notifications';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { requireDesk } from '@/app/api/v1/_lib/desk';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toClubTournamentDto } from '@/app/api/v1/_lib/tournament-dto';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/t/{slug}/admin/tournament-entries/{id}/confirm (#579): the club
 * confirms an entry while the draw has a place (38); 409 TOURNAMENT_DRAW_FULL past it.
 * Both of the pair are told. 409 TOURNAMENT_STATE once sign-up is over,
 * TOURNAMENT_ENTRY_NOT_ACTIVE for one not waiting for that.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const { tournamentId } = await decideEntry(
    { userId: ctx.userId, tenantId: ctx.tenantId },
    id,
    'confirm',
  );
  await notifyEntryDecided(id);
  const t = await getClubTournament(ctx.tenantId, tournamentId);
  return ok(toClubTournamentDto(t!));
}

export const POST = defineV1Route(handler);
