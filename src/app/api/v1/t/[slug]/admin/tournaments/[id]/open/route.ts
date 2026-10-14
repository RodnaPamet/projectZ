import { type NextRequest } from 'next/server';

import { getClubTournament, openTournament } from '@/app-layer/usecases/club-tournaments';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { requireDesk } from '@/app/api/v1/_lib/desk';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toClubTournamentDto } from '@/app/api/v1/_lib/tournament-dto';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/t/{slug}/admin/tournaments/{id}/open (#579): a draft opens for
 * sign-up. 409 TOURNAMENT_STATE for anything but a draft.
 */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  await openTournament({ userId: ctx.userId, tenantId: ctx.tenantId }, id);
  const t = await getClubTournament(ctx.tenantId, id);
  return ok(toClubTournamentDto(t!));
}

export const POST = defineV1Route(handler);
