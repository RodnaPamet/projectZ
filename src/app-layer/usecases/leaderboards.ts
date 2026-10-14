import type { PrismaClient, SportType } from '@prisma/client';

import { blockedEitherWay } from '@/app-layer/usecases/messaging-directory';
import { latestRows } from '@/app-layer/usecases/shown-ratings';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { avatarUrlOf } from '@/lib/media/avatar-url';
import { isProvisional, levelOfMean } from '@/lib/ratings/levels';

/**
 * A CLUB'S LEADERBOARDS (#578; decisions 35, 36, 47, 49 on #378).
 *
 *   whose        every player with a counted result at the club, in the sport
 *   who shows    a settled level only: 5 confirmed matches, one in the last
 *                six months (47, "the leaderboards' threshold"); nobody who
 *                hides their level (36); nobody in a block with the viewer
 *   in order     by the level, the mean everyone sees, highest first
 *   to whom      signed-in players, by full name (49); the club's public page
 *                shows a signed-out visitor a sign-in prompt instead
 *
 * A rating is the player's, the same at every club; the leaderboard is the
 * club's people ranked by it.
 */

export const LEADERBOARD_MAX = 100;
/** Players at one club in one sport, read to rank: generous for a pilot club. */
const PLAYERS_READ_MAX = 5_000;

export interface LeaderboardRow {
  rank: number;
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  /** 1–7, one decimal. */
  level: number;
  matchesPlayed: number;
}

export interface ClubLeaderboard {
  /** The sports with a counted result at the club, in the enum's order. */
  sports: SportType[];
  /** The sport shown: the one asked for, else the first. Null when there is none. */
  sport: SportType | null;
  rows: LeaderboardRow[];
}

/**
 * The leaderboard of the club behind `slug` in `sport` (or its first sport),
 * for `viewerId`. Null for a club that is not public.
 */
export async function clubLeaderboard(
  slug: string,
  viewerId: string,
  sport: SportType | null,
  now: Date = new Date(),
): Promise<ClubLeaderboard | null> {
  // guardrail-allow: cross-tenant — one public club by its slug, and the
  // ratings of the players with results there: each player's own rows.
  return runAsSuperuser((db) => read(db, slug, viewerId, sport, now));
}

async function read(
  db: PrismaClient,
  slug: string,
  viewerId: string,
  asked: SportType | null,
  now: Date,
): Promise<ClubLeaderboard | null> {
  const club = await db.venueOrg.findUnique({
    where: { slug },
    select: { id: true, status: true },
  });
  if (!club || club.status !== 'ACTIVE') return null;

  const played = await db.matchResultRecord.groupBy({
    by: ['sport'],
    where: { tenantId: club.id },
    orderBy: { sport: 'asc' },
  });
  const sports = played.map((p) => p.sport);
  const sport = asked && sports.includes(asked) ? asked : (sports[0] ?? null);
  if (!sport) return { sports, sport: null, rows: [] };

  const [people, blocked] = await Promise.all([
    db.matchParticipant.groupBy({
      by: ['userId'],
      where: { sport, match: { tenantId: club.id } },
      orderBy: { userId: 'asc' },
      take: PLAYERS_READ_MAX,
    }),
    blockedEitherWay(db, viewerId),
  ]);
  const hidden = new Set(blocked);
  const ids = people.map((p) => p.userId).filter((id) => !hidden.has(id));
  if (ids.length === 0) return { sports, sport, rows: [] };

  const [users, rows] = await Promise.all([
    db.user.findMany({
      where: { id: { in: ids }, deletedAt: null, ratingPublic: true },
      select: { id: true, name: true, avatarUrl: true },
      take: ids.length,
    }),
    latestRows(db, ids),
  ]);
  const shown = new Map(users.map((u) => [u.id, u]));
  const ranked = rows
    .filter((r) => r.sport === sport && shown.has(r.userId))
    .filter((r) => !isProvisional(r.matchesPlayed, r.computedAt, now))
    .map((r) => ({ r, mu: Number(r.mu) }))
    // Highest mean first; more matches, then the id, break a tie for a stable order.
    .sort(
      (x, y) =>
        y.mu - x.mu || y.r.matchesPlayed - x.r.matchesPlayed || (x.r.userId < y.r.userId ? -1 : 1),
    )
    .slice(0, LEADERBOARD_MAX);

  return {
    sports,
    sport,
    rows: ranked.map(({ r }, i) => {
      const u = shown.get(r.userId)!;
      return {
        rank: i + 1,
        userId: r.userId,
        name: u.name,
        avatarUrl: avatarUrlOf(u.avatarUrl),
        level: levelOfMean(r.engine, Number(r.mu)),
        matchesPlayed: r.matchesPlayed,
      };
    }),
  };
}
