import type { PrismaClient, SportType } from '@prisma/client';

import { runAsUserOnly } from '@/lib/db/rls-middleware';
import { readModules } from '@/lib/modules';
import { isProvisional, levelOfMean } from '@/lib/ratings/levels';

/**
 * WHAT A RATING SHOWS, AND TO WHOM (#576; decisions 31, 36, 47, 48 on #378).
 *
 *   everyone           the 1–7 level, one decimal, starting at the declared
 *                      level and moving with results (31); «неокончателно»
 *                      under 5 confirmed matches, or after six months away
 *                      (47, 48)
 *   the player alone   the engine's points, and the record (31): `myRatings`
 *   opted out          still rated, and shown to nobody but the player (36):
 *                      everyone else sees the level they declared, as before
 *                      ranking
 *
 * Nothing while the ranking module is off: every screen shows the declared
 * level as it always has.
 *
 * The declared levels and the rating history are each player's own rows
 * (owner-only under RLS), so the handle must read every player's: the callers
 * bind app_superuser for the cards already.
 */

export interface ShownRating {
  /** 1–7, one decimal. */
  level: number;
  provisional: boolean;
}

const key = (userId: string, sport: SportType) => `${userId}|${sport}`;

/** The most sports one person can have: every sport there is. */
const SPORTS_MAX = 40;

interface LatestRow {
  userId: string;
  sport: SportType;
  engine: 'OPENSKILL' | 'GLICKO2';
  mu: unknown;
  displayRating: unknown;
  matchesPlayed: number;
  computedAt: Date;
}

/** Each (player, sport)'s latest rating row: one grouped read, then those rows. */
async function latestRows(db: PrismaClient, userIds: readonly string[]): Promise<LatestRow[]> {
  if (userIds.length === 0) return [];
  const latest = await db.skillRatingHistory.groupBy({
    by: ['userId', 'sport'],
    where: { userId: { in: [...userIds] } },
    _max: { computedAt: true },
  });
  const wanted = latest.filter((l) => l._max.computedAt);
  if (wanted.length === 0) return [];
  return db.skillRatingHistory.findMany({
    where: {
      OR: wanted.map((l) => ({ userId: l.userId, sport: l.sport, computedAt: l._max.computedAt! })),
    },
    select: {
      userId: true,
      sport: true,
      engine: true,
      mu: true,
      displayRating: true,
      matchesPlayed: true,
      computedAt: true,
    },
    // One a (player, sport); two matches rated in the same instant are the
    // only way to tie, and either row is right.
    take: wanted.length * 2,
  });
}

/**
 * The ratings `viewerId` may see of `userIds`, by `userId|sport`: every sport
 * each player declared or has been rated in. Empty while the module is off.
 */
export async function shownRatings(
  db: PrismaClient,
  userIds: readonly string[],
  viewerId: string | null,
  now: Date = new Date(),
): Promise<Map<string, ShownRating>> {
  const out = new Map<string, ShownRating>();
  if (!readModules().ranking || userIds.length === 0) return out;

  const users = await db.user.findMany({
    where: { id: { in: [...userIds] } },
    select: { id: true, ratingPublic: true },
    take: userIds.length,
  });
  const visible = users.filter((u) => u.ratingPublic || u.id === viewerId).map((u) => u.id);
  if (visible.length === 0) return out;

  const [declared, rows] = await Promise.all([
    db.playerSportLevel.findMany({
      where: { userId: { in: visible } },
      select: { userId: true, sport: true, level: true },
      take: visible.length * SPORTS_MAX,
    }),
    latestRows(db, visible),
  ]);

  // A declared level nobody has played yet: where the rating starts (Q24).
  for (const d of declared) out.set(key(d.userId, d.sport), { level: d.level, provisional: true });
  for (const r of rows) {
    out.set(key(r.userId, r.sport), {
      level: levelOfMean(r.engine, Number(r.mu)),
      provisional: isProvisional(r.matchesPlayed, r.computedAt, now),
    });
  }
  return out;
}

/** One player's rating in one sport, as `shownRatings` keys it. */
export function ratingIn(
  ratings: Map<string, ShownRating>,
  userId: string,
  sport: SportType,
): ShownRating | null {
  return ratings.get(key(userId, sport)) ?? null;
}

export interface MyRating extends ShownRating {
  sport: SportType;
  /** The engine's own number (decision 31): for the player's own page only. Null before a first match. */
  points: number | null;
  matchesPlayed: number;
  lastPlayedAt: Date | null;
}

/**
 * The player's own ratings, for their own page (#576): every sport they
 * declared or were rated in, with the points nobody else sees, and whether
 * others see the level at all. Whatever the module switch says: the page asks
 * only while it is on.
 */
export async function myRatingsIn(
  db: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<{ public: boolean; items: MyRating[] }> {
  const [user, declared, rows] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { ratingPublic: true } }),
    db.playerSportLevel.findMany({
      where: { userId },
      select: { sport: true, level: true },
      take: SPORTS_MAX,
    }),
    latestRows(db, [userId]),
  ]);
  const bySport = new Map<SportType, MyRating>();
  for (const d of declared) {
    bySport.set(d.sport, {
      sport: d.sport,
      level: d.level,
      provisional: true,
      points: null,
      matchesPlayed: 0,
      lastPlayedAt: null,
    });
  }
  for (const r of rows) {
    bySport.set(r.sport, {
      sport: r.sport,
      level: levelOfMean(r.engine, Number(r.mu)),
      provisional: isProvisional(r.matchesPlayed, r.computedAt, now),
      points: Number(r.displayRating),
      matchesPlayed: r.matchesPlayed,
      lastPlayedAt: r.computedAt,
    });
  }
  return {
    public: user?.ratingPublic ?? true,
    items: [...bySport.values()].sort((a, b) =>
      a.sport < b.sport ? -1 : a.sport > b.sport ? 1 : 0,
    ),
  };
}

/** `myRatingsIn` as the player: their own declared levels and account row. */
export async function myRatings(
  userId: string,
  now: Date = new Date(),
): Promise<{ public: boolean; items: MyRating[] }> {
  return runAsUserOnly(userId, (db) => myRatingsIn(db, userId, now));
}
