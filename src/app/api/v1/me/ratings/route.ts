import { type NextRequest } from 'next/server';

import { myRatings } from '@/app-layer/usecases/shown-ratings';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/ratings (#576): the caller's own ratings, for their own page.
 * Every sport they declared or were rated in: the level (one decimal,
 * provisional under 5 confirmed matches or after six months away), the
 * engine's points nobody else sees (decision 31), the matches, and whether
 * others see the level (`public`; set with `PATCH /me { ratingPublic }`).
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const mine = await myRatings(ctx.userId);
  return ok({
    public: mine.public,
    items: mine.items.map((r) => ({
      sport: r.sport,
      level: r.level,
      provisional: r.provisional,
      points: r.points,
      matchesPlayed: r.matchesPlayed,
      lastPlayedAt: r.lastPlayedAt?.toISOString() ?? null,
    })),
  });
}

export const GET = defineV1Route(handler);
