import { type NextRequest } from 'next/server';

import { enterTournamentBodySchema } from '@/app-layer/schemas/tournaments';
import { enterTournament, getTournament } from '@/app-layer/usecases/club-tournaments';
import { notifyEntryReceived } from '@/app-layer/usecases/tournament-notifications';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toTournamentViewDto } from '@/app/api/v1/_lib/tournament-dto';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/tournaments/{id}/entries (#579): a player enters, alone or
 * naming a partner for doubles (decision 50). The entry waits for the club;
 * past the draw size, on the waiting list (51). The desk and the partner are
 * told. With an online fee (#581, decision 64) the entry awaits its payment
 * (`myEntry.payment.state: DUE`): the client opens
 * `POST /me/tournament-entries/{id}/checkout`, and the desk and the partner are
 * told once it is paid.
 *
 * 400 TOURNAMENT_PARTNER_REQUIRED; 403 PLAYER_ACCOUNT_REQUIRED, PHONE_REQUIRED;
 * 404; 409 TOURNAMENT_NOT_OPEN, TOURNAMENT_ALREADY_ENTERED,
 * TOURNAMENT_PARTNER_UNAVAILABLE; 429.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const body = await parseJsonBody(req, enterTournamentBodySchema, 'entry');
  const { entryId, needsPayment } = await enterTournament({
    userId: ctx.userId,
    tournamentId: id,
    partnerUserId: body.partnerUserId ?? null,
  });
  // An entry paid online is the club's once paid (#581): the webhook tells them then.
  if (!needsPayment) await notifyEntryReceived(entryId);
  const t = await getTournament(id, ctx.userId);
  return ok(toTournamentViewDto(t!), { status: 201 });
}

export const POST = defineV1Route(handler);
