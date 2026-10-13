import { type NextRequest } from 'next/server';

import { listPublicCoaches, PUBLIC_COACHES_MAX } from '@/app-layer/usecases/coach-directory';
import { toPublicCoach } from '@/app/api/v1/_lib/coach-dto';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { page } from '@/app/api/v1/_lib/envelope';
import { sportParam } from '@/app/api/v1/_lib/sport-param';
import { ValidationError } from '@/lib/errors/types';

/**
 * GET /api/v1/coaches?sport=&limit=&cursor=
 *
 * The coaches a player can book (#547; owner decision 10). Public: no sign-in.
 *
 * A coach is listed when the platform approved their profile and they teach at
 * one venue or more where a lesson can actually be booked: the venue and its
 * club are open, and the coach has set a rate, a lesson length and weekly
 * hours there. Each comes with the text, qualifications, sports and levels,
 * the picture, the venues with the rates there (cheapest first), and
 * `fromRateCents`, the lowest hourly rate among them.
 *
 * `sport` keeps only coaches who teach it; an unknown one is 400. Ordered by
 * the page address (`slug`), which is how a coach is named in public; the
 * account id is not given out. `cursor` is the `nextCursor` of the page
 * before; `limit` is 1 to 50, default 24.
 */
async function handler(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const sport = sportParam(sp.get('sport'));

  const rawLimit = sp.get('limit');
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > PUBLIC_COACHES_MAX)
  ) {
    throw new ValidationError(`\`limit\` must be 1 to ${PUBLIC_COACHES_MAX}`, { field: 'limit' });
  }
  const cursor = sp.get('cursor');
  if (cursor !== null && !/^[a-z0-9][a-z0-9-]{1,63}$/.test(cursor)) {
    throw new ValidationError('`cursor` is not one this endpoint gave out', { field: 'cursor' });
  }

  const { items, nextCursor } = await listPublicCoaches({ sport, limit, cursor });
  return page(items.map(toPublicCoach), nextCursor);
}

export const GET = defineV1Route(handler);
