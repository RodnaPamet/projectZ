import { type NextRequest } from 'next/server';

import { myTournamentEntries } from '@/app-layer/usecases/club-tournaments';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toTournamentViewDto } from '@/app/api/v1/_lib/tournament-dto';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/tournament-entries (#579): the tournaments the caller is in,
 * live, as entrant or partner, at every club: each with `myEntry`.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const items = await myTournamentEntries(ctx.userId);
  return ok({ items: items.map(toTournamentViewDto) });
}

export const GET = defineV1Route(handler);
