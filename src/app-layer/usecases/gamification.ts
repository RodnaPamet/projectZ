import type { PrismaClient, XpEventType } from '@prisma/client';

import {
  addPoints,
  rebuildLeaderboard,
  type LeaderboardPeriod,
} from '@/lib/gamification/leaderboard';
import { XP_TABLE, levelForXp } from '@/lib/gamification/rules';

/**
 * The gamification engine.
 *
 * Event-driven: something happens in the domain, an XP event is recorded, and
 * the leaderboard follows. The engine never inspects bookings itself — the
 * caller states what happened, and the engine decides what it is worth.
 */

/**
 * Award XP for something that happened.
 *
 * ─── Idempotency, and why it is not optional ─────────────────────────
 *
 * `dedupeKey` identifies the EVENT, not the attempt: `booking_completed:bk_123`.
 * The same booking completing twice is not a thing that can happen; the same
 * WEBHOOK arriving twice absolutely is, and so is a cron job re-running after a
 * deploy. Without the key, one completed booking pays out once per retry, and
 * the leaderboard ranks whoever's events got retried most.
 *
 * ─── Why createMany({skipDuplicates}) and not create() ───────────────
 *
 * A unique violation ABORTS the surrounding Postgres transaction. So the
 * tempting shape —
 *
 *     try { await tx.xpEvent.create(...) }
 *     catch (e) { if (isDuplicate(e)) return existing }   // ← cannot run
 *
 * — is broken: by the time we are in the catch, the transaction is dead and the
 * recovery read cannot execute. This is the third time this trap has come up in
 * this codebase (P09 bookings, P10 sessions, now here).
 *
 * `createMany({skipDuplicates: true})` does the conflict handling INSIDE the
 * statement (`ON CONFLICT DO NOTHING`) and returns a count. Count 0 means "this
 * event was already recorded" — a normal, expected outcome, not an error.
 */
export async function awardXp(
  db: PrismaClient,
  input: {
    tenantId?: string | null;
    userId: string;
    type: XpEventType;
    dedupeKey: string;
    /** Only for ADJUSTMENT; every other type is priced by the XP table. */
    points?: number;
    refType?: string;
    refId?: string;
  },
): Promise<{ awarded: boolean; points: number; totalXp: number; level: number }> {
  const points = input.type === 'ADJUSTMENT' ? (input.points ?? 0) : XP_TABLE[input.type];

  if (input.type === 'ADJUSTMENT' && !Number.isInteger(points)) {
    throw new Error(`An ADJUSTMENT needs an integer points value; got ${input.points}`);
  }

  const result = await db.xpEvent.createMany({
    data: [
      {
        tenantId: input.tenantId ?? null,
        userId: input.userId,
        type: input.type,
        points,
        dedupeKey: input.dedupeKey,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
      },
    ],
    skipDuplicates: true,
  });

  const awarded = result.count > 0;

  const totalXp = await totalXpFor(db, input.userId);

  // Only touch the leaderboard if we actually recorded something. A duplicate
  // delivery that still incremented the ZSET would inflate the score by exactly
  // the amount the dedupe key was there to prevent — the database would be
  // right and the leaderboard would be wrong, which is the worst of both.
  if (awarded && points !== 0) {
    await addPoints({
      userId: input.userId,
      tenantId: input.tenantId,
      points,
    });
  }

  return { awarded, points: awarded ? points : 0, totalXp, level: levelForXp(totalXp) };
}

/**
 * A player's XP is the SUM of their events. Never a stored counter.
 *
 * A denormalised `totalXp` column would have to be kept in step with the event
 * log by every code path that ever writes one, and the day they disagree there
 * is no way to tell which is right. The sum is cheap (indexed by userId) and
 * cannot drift.
 */
export async function totalXpFor(db: PrismaClient, userId: string): Promise<number> {
  // guardrail-allow: cross-tenant — a player's XP total is THEIRS, not a club's.
  // They play at several venues and their level travels with them; scoping this
  // to one tenant would show a different level on every club's page, which is
  // not a level, it is a per-club score we never intended to build.
  const agg = await db.xpEvent.aggregate({
    where: { userId },
    _sum: { points: true },
  });

  // A clawback can in principle take someone below zero (a refunded booking
  // whose XP they already spent on nothing). Floor it: a negative level is not
  // a thing, and `levelForXp` refuses negative input by design.
  return Math.max(0, agg._sum.points ?? 0);
}

/**
 * Take XP back.
 *
 * A refunded booking, a review a moderator removed. The event that earned the
 * points is NOT deleted — a compensating negative event is appended, exactly as
 * with the credit ledger. Deleting the original would erase the fact that it
 * happened, and "why did my XP drop?" would have no answer.
 *
 * The dedupe key is derived from the original, so a clawback also runs exactly
 * once however many times the refund webhook is delivered.
 */
export async function clawback(
  db: PrismaClient,
  input: { tenantId?: string | null; userId: string; originalDedupeKey: string; reason: string },
): Promise<{ clawedBack: boolean; points: number }> {
  const original = await db.xpEvent.findUnique({
    where: { dedupeKey: input.originalDedupeKey },
  });

  // Nothing to claw back. Not an error: a booking can be refunded before it was
  // ever completed, in which case no XP was awarded in the first place.
  if (!original || original.points <= 0) return { clawedBack: false, points: 0 };

  const result = await awardXp(db, {
    tenantId: input.tenantId,
    userId: input.userId,
    type: 'ADJUSTMENT',
    points: -original.points,
    dedupeKey: `clawback:${input.originalDedupeKey}`,
    refType: 'clawback',
    refId: original.id,
  });

  return { clawedBack: result.awarded, points: result.awarded ? -original.points : 0 };
}

// ══ Achievements ═════════════════════════════════════════════════════

interface CountRule {
  type: 'COUNT';
  event: XpEventType;
  threshold: number;
}

interface XpRule {
  type: 'TOTAL_XP';
  threshold: number;
}

type AchievementRule = CountRule | XpRule;

/**
 * Evaluate every achievement the player has not already unlocked.
 *
 * Only the LOCKED ones are evaluated, which is both faster and the thing that
 * makes the XP reward safe: re-granting a badge would re-grant its XP, turning
 * "play 100 games" into an infinite tap that pays out on every booking
 * thereafter. The `@@unique([userId, achievementCode])` is the backstop, and
 * `createMany({skipDuplicates})` means hitting it is not an error.
 */
export async function evaluateAchievements(
  db: PrismaClient,
  input: { tenantId?: string | null; userId: string },
): Promise<string[]> {
  // guardrail-allow: cross-tenant — `achievement` and `user_achievement` carry
  // no tenantId BY DESIGN. A badge belongs to the player, not to the club where
  // they happened to earn it, and it follows them when they move.
  const [all, unlocked] = await Promise.all([
    db.achievement.findMany({ take: 200 }),
    db.userAchievement.findMany({ where: { userId: input.userId }, take: 200 }),
  ]);

  const already = new Set(unlocked.map((u) => u.achievementCode));
  const candidates = all.filter((a) => !already.has(a.code));
  if (candidates.length === 0) return [];

  // One grouped query for the counts, rather than one per candidate badge.
  //
  // guardrail-allow: cross-tenant — an achievement is earned by a PERSON, not
  // at a club. Scoping this to one tenant would reset every badge each time a
  // player joined a second venue. Keyed on userId, and xp_event is protected
  // per-user by its owner-only policy.
  const counts = await db.xpEvent.groupBy({
    by: ['type'],
    where: { userId: input.userId, points: { gt: 0 } },
    _count: { _all: true },
  });

  const countByType = new Map(counts.map((c) => [c.type, c._count._all]));
  const totalXp = await totalXpFor(db, input.userId);

  const newlyUnlocked: string[] = [];

  for (const achievement of candidates) {
    const rule = achievement.ruleJson as unknown as AchievementRule;
    if (!isSatisfied(rule, { countByType, totalXp })) continue;

    const created = await db.userAchievement.createMany({
      data: [{ userId: input.userId, achievementCode: achievement.code }],
      skipDuplicates: true,
    });

    // Lost the race with a concurrent evaluation — the other one granted it,
    // and it must not be paid for twice.
    if (created.count === 0) continue;

    newlyUnlocked.push(achievement.code);

    if (achievement.xpReward > 0) {
      await awardXp(db, {
        tenantId: input.tenantId,
        userId: input.userId,
        type: 'ADJUSTMENT',
        points: achievement.xpReward,
        // Keyed on the badge, so the reward is payable exactly once, ever.
        dedupeKey: `achievement:${input.userId}:${achievement.code}`,
        refType: 'achievement',
        refId: achievement.code,
      });
    }
  }

  return newlyUnlocked;
}

function isSatisfied(
  rule: AchievementRule,
  ctx: { countByType: Map<XpEventType, number>; totalXp: number },
): boolean {
  // An unknown rule shape must NOT unlock. A typo in a badge's ruleJson should
  // leave it locked, not hand it to everyone on the platform.
  switch (rule?.type) {
    case 'COUNT':
      return (ctx.countByType.get(rule.event) ?? 0) >= rule.threshold;
    case 'TOTAL_XP':
      return ctx.totalXp >= rule.threshold;
    default:
      return false;
  }
}

/**
 * Rebuild a leaderboard from the event log.
 *
 * This is what makes Redis disposable — see the note in leaderboard.ts. An
 * eviction or a flushed instance costs one call to this.
 */
export async function rebuildFromEvents(
  db: PrismaClient,
  period: LeaderboardPeriod,
  scope: { tenantId?: string | null },
  window: { from?: Date; at?: Date } = {},
): Promise<number> {
  const totals = await db.xpEvent.groupBy({
    by: ['userId'],
    where: {
      ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
      ...(window.from ? { createdAt: { gte: window.from } } : {}),
    },
    _sum: { points: true },
  });

  const rows = totals
    .map((t) => ({ userId: t.userId, points: t._sum.points ?? 0 }))
    // A player whose net XP in the window is zero or negative does not belong
    // on a leaderboard — and a ZSET happily stores negative scores, so they
    // would appear, ranked below everyone, as a permanent monument to a refund.
    .filter((t) => t.points > 0);

  await rebuildLeaderboard(period, scope, rows, window.at);

  return rows.length;
}
