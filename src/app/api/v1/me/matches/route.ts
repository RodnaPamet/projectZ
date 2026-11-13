import { type NextRequest } from 'next/server';

import { myMatches } from '@/app-layer/usecases/my-stats';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { sportParam } from '@/app/api/v1/_lib/sport-param';
import { toMyMatchDto } from '@/app/api/v1/_lib/stats-dto';
import { UnauthorizedError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

const CURSOR_RE = /^[a-z0-9]{1,40}$/;

/**
 * GET /api/v1/me/matches?sport=PADEL&cursor=…&limit=20 (#688): the caller's
 * counted matches in one sport, newest first, for «Профил» → «Мачове»: the
 * venue, partners and opponents, the score from the caller's side, and the
 * level before and after. `nextCursor` asks for the next page.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const params = req.nextUrl.searchParams;
  const sport = sportParam(params.get('sport')) ?? null;
  const cursor = params.get('cursor');
  if (cursor !== null && !CURSOR_RE.test(cursor)) {
    throw new ValidationError('Invalid cursor', { field: 'cursor' });
  }
  const limitRaw = params.get('limit');
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
    throw new ValidationError('limit must be 1–50', { field: 'limit' });
  }
  const page = await myMatches(ctx.userId, sport, { cursor, limit });
  return ok({
    sport: page.sport,
    items: page.items.map(toMyMatchDto),
    nextCursor: page.nextCursor,
  });
}

export const GET = defineV1Route(handler);
