import { type NextRequest } from 'next/server';

import { openTournamentsQuerySchema } from '@/app-layer/schemas/tournaments';
import { listOpenTournaments } from '@/app-layer/usecases/club-tournaments';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toTournamentDto } from '@/app/api/v1/_lib/tournament-dto';
import { ValidationError } from '@/lib/errors/types';

/**
 * GET /api/v1/tournaments?city=&sport= (#579, decision 53): tournaments open
 * for sign-up at every club, soonest first. Public, as Игри's games are.
 */
async function handler(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = openTournamentsQuerySchema.safeParse({
    city: sp.get('city') || undefined,
    sport: sp.get('sport') || undefined,
  });
  if (!q.success)
    throw new ValidationError('Invalid filter', { field: q.error.issues[0]?.path.join('.') });
  const items = await listOpenTournaments(q.data);
  return ok({ items: items.map(toTournamentDto) });
}

export const GET = defineV1Route(handler);
