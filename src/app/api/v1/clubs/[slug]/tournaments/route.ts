import { type NextRequest } from 'next/server';

import { slugSchema } from '@/app-layer/schemas/common';
import { listClubPublicTournaments } from '@/app-layer/usecases/club-tournaments';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { toTournamentDto } from '@/app/api/v1/_lib/tournament-dto';

/**
 * GET /api/v1/clubs/{slug}/tournaments (#579, decision 53): a club's
 * tournaments open for sign-up or under way, for its public page. Public.
 * An unknown or hidden club has none.
 */
async function handler(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const items = slugSchema.safeParse(slug).success ? await listClubPublicTournaments(slug) : [];
  return ok({ items: items.map(toTournamentDto) });
}

export const GET = defineV1Route(handler);
