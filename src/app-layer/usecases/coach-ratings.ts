import type { PrismaClient } from '@prisma/client';

import { bayesianAverageFromTotals } from '@/lib/ratings/score';

/**
 * A coach's rating (#551; decision 27), on its own so that the public coach
 * pages read it without loading the review writes behind it.
 */

export interface CoachRating {
  /** The weighted average venues use (decision 27); 0 when there are none. */
  avgRating: number;
  reviewCount: number;
}

export const NO_RATING: CoachRating = { avgRating: 0, reviewCount: 0 };

/**
 * Each coach's rating from their PUBLISHED reviews, at every club, read with
 * the caller's handle (the public pages read under the superuser binding
 * already, and say why).
 */
export async function readCoachRatings(
  db: PrismaClient,
  coachUserIds: readonly string[],
): Promise<Map<string, CoachRating>> {
  const ids = [...new Set(coachUserIds)];
  if (ids.length === 0) return new Map();
  // guardrail-allow: cross-tenant — published reviews are public, and a
  // coach's rating is over every club they teach at.
  const rows = await db.coachReview.groupBy({
    by: ['coachUserId'],
    where: { coachUserId: { in: ids }, status: 'PUBLISHED' },
    _sum: { rating: true },
    _count: { _all: true },
    orderBy: { coachUserId: 'asc' },
    take: ids.length,
  });
  const out = new Map<string, CoachRating>();
  for (const id of ids) out.set(id, NO_RATING);
  for (const r of rows) {
    const count = r._count._all;
    out.set(r.coachUserId, {
      avgRating: count === 0 ? 0 : bayesianAverageFromTotals(r._sum.rating ?? 0, count),
      reviewCount: count,
    });
  }
  return out;
}
