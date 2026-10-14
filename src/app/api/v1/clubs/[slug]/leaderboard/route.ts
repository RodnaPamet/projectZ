import { type NextRequest } from 'next/server';

import { slugSchema } from '@/app-layer/schemas/common';
import { clubLeaderboard } from '@/app-layer/usecases/leaderboards';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { sportParam } from '@/app/api/v1/_lib/sport-param';
import { NotFoundError, UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/clubs/{slug}/leaderboard?sport=PADEL (#578): the club's players
 * by level in one sport, settled levels only (5 confirmed matches, one in six
 * months), nobody who hides theirs, nobody in a block with the caller. Without
 * `?sport=`, the club's first sport with a result; `sports` lists them all.
 *
 * For signed-in callers only: full names (decision 49). 404 for a club that is
 * not public.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  if (!slugSchema.safeParse(slug).success) throw new NotFoundError('Club not found');
  const sport = sportParam(req.nextUrl.searchParams.get('sport')) ?? null;
  const board = await clubLeaderboard(slug, ctx.userId, sport);
  if (!board) throw new NotFoundError('Club not found');
  return ok(board);
}

export const GET = defineV1Route(handler);
