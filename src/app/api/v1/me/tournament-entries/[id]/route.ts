import { type NextRequest } from 'next/server';

import { getTournament, withdrawEntry } from '@/app-layer/usecases/club-tournaments';
import { notifyEntryWithdrawn } from '@/app-layer/usecases/tournament-notifications';
import { processDueRefunds } from '@/app-layer/usecases/tournament-payments';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toTournamentViewDto } from '@/app/api/v1/_lib/tournament-dto';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * DELETE /api/v1/me/tournament-entries/{id} (#579): the entrant or the
 * partner withdraws a live entry before the tournament starts (decision 50).
 * The other of the pair is told, and the desk if the club had confirmed it.
 *
 * 404 for an entry the caller is not on; 409 TOURNAMENT_STATE once it has
 * started, TOURNAMENT_ENTRY_NOT_ACTIVE for one already over.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const { tournamentId, wasConfirmed, wasUnpaid } = await withdrawEntry(ctx.userId, id);
  if (!wasUnpaid) await notifyEntryWithdrawn(id, wasConfirmed);
  // A fee paid online and owed back (65): made now, or by the sweep.
  await processDueRefunds({ entryIds: [id] });
  const t = await getTournament(tournamentId, ctx.userId);
  return ok(t ? toTournamentViewDto(t) : null);
}

export const DELETE = defineV1Route(handler);
