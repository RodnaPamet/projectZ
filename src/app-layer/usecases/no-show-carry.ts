import type { PrismaClient } from '@prisma/client';

import { NO_SHOW_WINDOW_DAYS, noShowCountsFrom } from '@/app-layer/usecases/booking-rules';
import { noShowFingerprint } from '@/lib/account/no-show-fingerprint';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

/**
 * A deleted account's no-show standing, carried to the next account made with
 * the same address (#370 review; owner decision 2026-10-08: "carry the no-show
 * block over").
 *
 *   carry     the deletion keeps, per club, each no-show that still counts
 *             there, with a keyed fingerprint of the address. Nothing when
 *             there is no standing anywhere.
 *   inherit   a sign-in to an account with that address takes them over: its
 *             standing at each club counts them, until each lapses, exactly
 *             as the deleted account's would have.
 *   purge     the completion sweep drops each one the moment it stops
 *             counting (90 days after its booking started).
 *
 * The no-shows THEMSELVES stay where they were: the club's bookings, kept
 * under the tombstone. What is carried is only what the block is computed
 * from. Tags, notes and history stay behind.
 */

const DAY_MS = 86_400_000;
/** Far beyond any person's no-shows in 90 days; a ceiling, not a page. */
const CARRY_CAP = 5_000;

const windowStart = (now: Date) => new Date(now.getTime() - NO_SHOW_WINDOW_DAYS * DAY_MS);

/**
 * Inside the deletion's transaction (superuser), BEFORE the club
 * relationships are deleted: each club's lifted block decides what still
 * counts. Rows the account inherited are carried again under its own
 * tombstone, then deleted, so nothing counts twice.
 */
export async function carryNoShowStanding(
  db: PrismaClient,
  input: { userId: string; email: string; now: Date },
): Promise<number> {
  const { userId, now } = input;
  const from = windowStart(now);
  const [bookings, inherited, lifted] = await Promise.all([
    // guardrail-allow: cross-tenant — the person's own no-shows, at every club.
    db.booking.findMany({
      where: { bookedByUserId: userId, status: 'NO_SHOW', startTs: { gt: from } },
      select: { tenantId: true, startTs: true },
      take: CARRY_CAP,
    }),
    // guardrail-allow: cross-tenant — what the person took over from a deleted account.
    db.noShowCarry.findMany({
      where: { inheritedByUserId: userId, startedAt: { gt: from } },
      select: { tenantId: true, startedAt: true },
      take: CARRY_CAP,
    }),
    // guardrail-allow: cross-tenant — the blocks clubs lifted for the person.
    db.playerVenueRelationship.findMany({
      where: { playerUserId: userId, noShowBlockClearedAt: { not: null } },
      select: { tenantId: true, noShowBlockClearedAt: true },
      take: CARRY_CAP,
    }),
  ]);

  const clearedAt = new Map(lifted.map((r) => [r.tenantId, r.noShowBlockClearedAt]));
  const counting = [
    ...bookings.map((b) => ({ tenantId: b.tenantId, startedAt: b.startTs })),
    ...inherited,
  ].filter((s) => s.startedAt > noShowCountsFrom(now, clearedAt.get(s.tenantId) ?? null));

  // guardrail-allow: cross-tenant — re-carried below, under this account's own tombstone.
  await db.noShowCarry.deleteMany({ where: { inheritedByUserId: userId } });
  if (counting.length === 0) return 0;

  const fingerprint = noShowFingerprint(input.email);
  await db.noShowCarry.createMany({
    data: counting.map((s) => ({
      tenantId: s.tenantId,
      fingerprint,
      deletedUserId: userId,
      startedAt: s.startedAt,
    })),
  });
  return counting.length;
}

/**
 * At sign-in: an account whose address matches a deleted account's carried
 * standing takes it over, and each club's players screen shows the account
 * with it. Idempotent: rows already taken over are left alone, so running it
 * at every sign-in costs one indexed lookup.
 */
export async function inheritNoShowStanding(userId: string, email: string): Promise<number> {
  const fingerprint = noShowFingerprint(email);
  return runAsSuperuser(async (db) => {
    // guardrail-allow: cross-tenant — carried rows wait under no club binding.
    const waiting = await db.noShowCarry.findMany({
      where: { fingerprint, inheritedByUserId: null, NOT: { deletedUserId: userId } },
      select: { id: true, tenantId: true },
      take: CARRY_CAP,
    });
    if (waiting.length === 0) return 0;

    // guardrail-allow: cross-tenant — the same rows, by id.
    await db.noShowCarry.updateMany({
      where: { id: { in: waiting.map((w) => w.id) }, inheritedByUserId: null },
      data: { inheritedByUserId: userId },
    });

    const perClub = new Map<string, number>();
    for (const w of waiting) perClub.set(w.tenantId, (perClub.get(w.tenantId) ?? 0) + 1);
    for (const [tenantId, n] of perClub) {
      // One per club the deleted account missed bookings at: a handful.
      await db.playerVenueRelationship.upsert({
        // guardrail-allow: n-plus-one
        where: { tenantId_playerUserId: { tenantId, playerUserId: userId } },
        create: { tenantId, playerUserId: userId, noShowCount: n },
        update: { noShowCount: { increment: n } },
      });
    }
    return waiting.length;
  });
}

/** Drop every carried no-show that has stopped counting. The completion sweep calls it. */
export async function purgeLapsedNoShowCarries(db: PrismaClient, now: Date = new Date()) {
  // guardrail-allow: cross-tenant — machine work over every club, as the sweep is.
  const { count } = await db.noShowCarry.deleteMany({
    where: { startedAt: { lte: windowStart(now) } },
  });
  return count;
}
