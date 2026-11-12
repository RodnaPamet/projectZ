import { type NextRequest } from 'next/server';

import { listOpenGames } from '@/app-layer/usecases/open-play';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { page } from '@/app/api/v1/_lib/envelope';
import { toOpenGameDto } from '@/app/api/v1/_lib/open-play-dto';
import { sportParam } from '@/app/api/v1/_lib/sport-param';
import { ValidationError } from '@/lib/errors/types';
import { MAX_SPORT_LEVEL, MIN_SPORT_LEVEL } from '@/lib/profile/limits';
import { getRequestId } from '@/lib/observability/context';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A whole number in [min, max], or a 400 naming the field; absent is undefined. */
function intParam(
  sp: URLSearchParams,
  field: string,
  min: number,
  max: number,
): number | undefined {
  const raw = sp.get(field);
  if (raw === null) return undefined;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`\`${field}\` is a whole number from ${min} to ${max}`, { field });
  }
  return n;
}

/**
 * GET /api/v1/games — open games (#376), soonest first: open, before the
 * club's cutoff, within the next two weeks, with a spot left, at a public
 * venue. Anyone may read it, signed in or not; a signed-in player also gets
 * their own part in each (`viewer`). Filters: `sport`, `date` (YYYY-MM-DD at
 * the venue), `dateFrom`/`dateTo`, `fromHour`/`toHour` (start hour at the
 * venue), `indoor`, `level` (#668), `city`, `venue` (a venue id). Keyset-paged
 * by `cursor`.
 */
async function handler(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const date = sp.get('date') ?? undefined;
  if (date !== undefined && !ISO_DAY.test(date)) {
    throw new ValidationError('`date` is YYYY-MM-DD', { field: 'date' });
  }
  for (const field of ['dateFrom', 'dateTo'] as const) {
    const v = sp.get(field);
    if (v !== null && !ISO_DAY.test(v))
      throw new ValidationError(`\`${field}\` is YYYY-MM-DD`, { field });
  }
  const fromHour = intParam(sp, 'fromHour', 0, 23);
  const toHour = intParam(sp, 'toHour', 1, 24);
  const level = intParam(sp, 'level', MIN_SPORT_LEVEL, MAX_SPORT_LEVEL);
  const indoorRaw = sp.get('indoor');
  if (indoorRaw !== null && indoorRaw !== 'true' && indoorRaw !== 'false') {
    throw new ValidationError('`indoor` is true or false', { field: 'indoor' });
  }
  const limit = sp.has('limit') ? Number(sp.get('limit')) : undefined;
  const result = await listOpenGames(
    {
      sport: sportParam(sp.get('sport')),
      date,
      dateFrom: sp.get('dateFrom') ?? undefined,
      dateTo: sp.get('dateTo') ?? undefined,
      fromHour,
      toHour,
      indoor: indoorRaw === null ? undefined : indoorRaw === 'true',
      level,
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
