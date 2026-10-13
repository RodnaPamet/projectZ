import { type NextRequest } from 'next/server';

import { listOpenGames } from '@/app-layer/usecases/open-play';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { page } from '@/app/api/v1/_lib/envelope';
import { toOpenGameDto } from '@/app/api/v1/_lib/open-play-dto';
import { sportParam } from '@/app/api/v1/_lib/sport-param';
import { ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/v1/games — open games (#376), soonest first: open, before the
 * club's cutoff, within the next two weeks, with a spot left, at a public
 * venue. Anyone may read it, signed in or not; a signed-in player also gets
 * their own part in each (`viewer`). Filters: `sport`, `date` (YYYY-MM-DD at
 * the venue), `city`, `venue` (a venue id). Keyset-paged by `cursor`.
 */
async function handler(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const date = sp.get('date') ?? undefined;
  if (date !== undefined && !ISO_DAY.test(date)) {
    throw new ValidationError('`date` is YYYY-MM-DD', { field: 'date' });
  }
  const limit = sp.has('limit') ? Number(sp.get('limit')) : undefined;
  const result = await listOpenGames(
    {
      sport: sportParam(sp.get('sport')),
      date,
      city: sp.get('city')?.trim() || undefined,
      venueId: sp.get('venue')?.trim() || undefined,
    },
    {
      viewerId: ctx.userId ?? null,
      cursor: sp.get('cursor'),
      limit: Number.isFinite(limit) ? limit : undefined,
    },
  );
  return page(result.items.map(toOpenGameDto), result.nextCursor);
}

export const GET = defineV1Route(handler);
