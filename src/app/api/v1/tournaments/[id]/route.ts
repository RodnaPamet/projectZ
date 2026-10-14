import { type NextRequest } from 'next/server';

import { getTournament } from '@/app-layer/usecases/club-tournaments';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toTournamentViewDto } from '@/app/api/v1/_lib/tournament-dto';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/tournaments/{id} (#579): one tournament, public, and the
 * signed-in caller's own entry as entrant or partner (`myEntry`). 404 for a
 * draft or a club that is not public.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const t = await getTournament(id, ctx.userId ?? null);
  if (!t) throw new NotFoundError('Tournament not found');
  return ok(toTournamentViewDto(t));
}

export const GET = defineV1Route(handler);
