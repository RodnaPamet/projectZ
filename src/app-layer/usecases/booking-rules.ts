import type { PrismaClient } from '@prisma/client';

import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { MAX_CANCELLATION_CUTOFF_HOURS, playerCancellableUntil } from '@/lib/booking/cutoff';
import { translateFor } from '@/lib/i18n/server-messages';

/**
 * The Sofia pilot's booking rules (#354), in one place.
 *
 * Owner decisions, 2026-10-04:
 *
 *   - A booking made online is CONFIRMED at once and paid at the club.
 *   - A player cancels in the app until the club's cutoff (default 24 h before
 *     the start). After that only the club's staff can cancel.
 *   - Three no-shows in 90 days block ONLINE booking at that club until staff
 *     lift the block.
 *
 * The two refusals here are the player's to read, so their messages are written
 * in the player's stored `User.locale`, as `PlayerAccountRequiredError` is. A
 * client still switches on the code, never the message.
 */

/** How many no-shows block online booking. */
export const NO_SHOW_BLOCK_THRESHOLD = 3;
/** Over how many days they are counted. */
export const NO_SHOW_WINDOW_DAYS = 90;

const DAY_MS = 86_400_000;

// ─── The no-show block ──────────────────────────────────────────────

/**
 * The player has too many recent no-shows at this club to book online.
 *
 * 403, not 409: nothing about the slot is wrong and retrying will not help.
 * The cure is the club, which is what the message says.
 */
export class NoShowBlockedError extends Error {
  constructor(
    message: string,
    readonly recentNoShows: number,
  ) {
    super(message);
    this.name = 'NoShowBlockedError';
  }
}

export interface NoShowStanding {
  /** NO_SHOW bookings that count: started in the window, and after the last clear. */
  recentNoShows: number;
  blocked: boolean;
  /** When staff last lifted a block for this player here, if ever. */
  clearedAt: Date | null;
}

/** The earliest start that still counts, given the window and the last clear. */
function countsFrom(now: Date, clearedAt: Date | null): Date {
  const windowStart = new Date(now.getTime() - NO_SHOW_WINDOW_DAYS * DAY_MS);
  return clearedAt && clearedAt > windowStart ? clearedAt : windowStart;
}

/**
 * Is this player blocked from booking online at this club?
 *
 * ═══ COMPUTED, NEVER STORED ═══
 *
 * The block is a COUNT of the club's own NO_SHOW bookings for this player, read
 * at the moment it matters. A stored `blocked` flag would need a writer on every
 * path that makes or unmakes a no-show, and a sweep to let the 90 days lapse —
 * three places to forget, each failing in the player's disfavour or the club's.
 * `PlayerVenueRelationship.noShowCount` is not used either: it is a lifetime
 * total with no dates, so it cannot answer "in the last 90 days".
 *
 * A no-show is dated by the booking's START, which is when it happened. Staff
 * lifting the block sets `noShowBlockClearedAt`; no-shows that started at or
 * before it stop counting, so a lifted block stays lifted until three NEW ones.
 * (A no-show marked after a clear for a booking that started before it is
 * therefore forgiven too. That is the desk's own record, reviewed by the same
 * people who just lifted the block.)
 *
 * Runs inside the caller's tenant binding; the explicit `tenantId` is the same
 * belt-and-braces every repository here carries.
 */
export async function noShowStanding(
  db: PrismaClient,
  tenantId: string,
  playerUserId: string,
  now: Date = new Date(),
): Promise<NoShowStanding> {
  const rel = await db.playerVenueRelationship.findUnique({
    where: { tenantId_playerUserId: { tenantId, playerUserId } },
    select: { noShowBlockClearedAt: true },
  });
  const clearedAt = rel?.noShowBlockClearedAt ?? null;

  const recentNoShows = await db.booking.count({
    where: {
      tenantId,
      bookedByUserId: playerUserId,
      status: 'NO_SHOW',
      startTs: { gt: countsFrom(now, clearedAt) },
    },
  });

  return { recentNoShows, blocked: recentNoShows >= NO_SHOW_BLOCK_THRESHOLD, clearedAt };
}

/**
 * Refuse an online booking from a blocked player, in their own language.
 *
 * ═══ THE RACE WITH THE THIRD NO-SHOW ═══
 *
 * This is a read followed by the booking's INSERT, and staff may commit a third
 * no-show between the two. The booking then lands. That is not a hole: the
 * booking request and the no-show were concurrent, and the outcome is exactly
 * the one where the booking came first — which the block, by the owner's rule,
 * does not reach back and undo. The next booking is refused. Serialising the two
 * (a lock on the player's relationship row) would buy nothing a person could
 * tell apart from that ordering.
 */
export async function assertMayBookOnline(
  db: PrismaClient,
  tenantId: string,
  playerUserId: string,
  now: Date = new Date(),
): Promise<void> {
  const standing = await noShowStanding(db, tenantId, playerUserId, now);
  if (!standing.blocked) return;

  const account = await db.user.findUnique({
    where: { id: playerUserId },
    select: { locale: true },
  });
  throw new NoShowBlockedError(
    await translateFor(account?.locale, 'bookingRules.noShowBlocked', {
      count: standing.recentNoShows,
      days: NO_SHOW_WINDOW_DAYS,
    }),
    standing.recentNoShows,
  );
}

/**
 * Every listed player's standing, in two queries rather than two per player.
 *
 * For the players screen. The NO_SHOW rows are bounded by the window and by the
 * id set, and filtered against each player's own clear in memory — a grouped
 * COUNT cannot take a different lower bound per group.
 */
export async function noShowStandings(
  db: PrismaClient,
  tenantId: string,
  players: ReadonlyArray<{ playerUserId: string; noShowBlockClearedAt: Date | null }>,
  now: Date = new Date(),
): Promise<Map<string, NoShowStanding>> {
  const out = new Map<string, NoShowStanding>();
  if (players.length === 0) return out;

  const windowStart = new Date(now.getTime() - NO_SHOW_WINDOW_DAYS * DAY_MS);
  const rows = await db.booking.findMany({
    where: {
      tenantId,
      bookedByUserId: { in: players.map((p) => p.playerUserId) },
      status: 'NO_SHOW',
      startTs: { gt: windowStart },
    },
    select: { bookedByUserId: true, startTs: true },
    // A club marks a handful of no-shows a week; this is a ceiling, not a page.
    take: 5_000,
  });

  const startsBy = new Map<string, Date[]>();
  for (const r of rows) {
    if (!r.bookedByUserId) continue;
    const list = startsBy.get(r.bookedByUserId) ?? [];
    list.push(r.startTs);
    startsBy.set(r.bookedByUserId, list);
  }

  for (const p of players) {
    const from = countsFrom(now, p.noShowBlockClearedAt);
    const recentNoShows = (startsBy.get(p.playerUserId) ?? []).filter((s) => s > from).length;
    out.set(p.playerUserId, {
      recentNoShows,
      blocked: recentNoShows >= NO_SHOW_BLOCK_THRESHOLD,
      clearedAt: p.noShowBlockClearedAt,
    });
  }

  return out;
}

export class NoShowBlockNotSetError extends Error {
  constructor() {
    super('That player is not blocked from booking online at this club.');
    this.name = 'NoShowBlockNotSetError';
  }
}

/**
 * Staff lift a player's no-show block.
 *
 * Refused when there is no block to lift, so a stray click cannot pre-forgive
 * no-shows that have not reached the threshold yet. Who and when are written on
 * the relationship (for the players screen) and in the audit log (the record).
 *
 * The id is checked before it reaches Prisma, for the reason `players.ts`
 * gives: `undefined` in a `where` means "not specified".
 */
export async function clearNoShowBlock(
  db: PrismaClient,
  tenantId: string,
  input: { playerUserId: string; actorUserId: string; now?: Date },
): Promise<{ clearedAt: Date; recentNoShows: number }> {
  if (typeof input.playerUserId !== 'string' || input.playerUserId.trim() === '') {
    throw new NoShowBlockNotSetError();
  }
  const now = input.now ?? new Date();

  const standing = await noShowStanding(db, tenantId, input.playerUserId, now);
  if (!standing.blocked) throw new NoShowBlockNotSetError();

  await db.playerVenueRelationship.upsert({
    where: { tenantId_playerUserId: { tenantId, playerUserId: input.playerUserId } },
    create: {
      tenantId,
      playerUserId: input.playerUserId,
      noShowBlockClearedAt: now,
      noShowBlockClearedByUserId: input.actorUserId,
    },
    update: { noShowBlockClearedAt: now, noShowBlockClearedByUserId: input.actorUserId },
  });

  await appendAuditEntry(db, {
    tenantId,
    actorUserId: input.actorUserId,
    actorType: 'USER',
    entity: 'PlayerVenueRelationship',
    entityId: input.playerUserId,
    action: AUDIT_ACTIONS.PLAYER_NO_SHOW_BLOCK_CLEARED,
    details: `No-show block lifted (${standing.recentNoShows} in ${NO_SHOW_WINDOW_DAYS} days)`,
    detailsJson: {
      category: 'player',
      summary: 'Staff lifted the no-show block on online booking',
      recentNoShows: standing.recentNoShows,
      windowDays: NO_SHOW_WINDOW_DAYS,
      previousClearedAt: standing.clearedAt?.toISOString() ?? null,
      clearedAt: now.toISOString(),
    },
  });

  return { clearedAt: now, recentNoShows: standing.recentNoShows };
}

// ─── The cancellation cutoff ────────────────────────────────────────

/**
 * A player tried to cancel after the club's cutoff, or after the start.
 *
 * 403: the booking is fine and so is the request; the player may not, and the
 * club can. The message says to contact the club.
 */
export class CancellationCutoffPassedError extends Error {
  constructor(
    message: string,
    readonly cancellableUntil: Date,
  ) {
    super(message);
    this.name = 'CancellationCutoffPassedError';
  }
}

/** Build the refusal, in the caller's own language. */
export async function cancellationCutoffError(
  db: PrismaClient,
  input: { userId: string; startTs: Date; cutoffHours: number; now: Date },
): Promise<CancellationCutoffPassedError> {
  const account = await db.user.findUnique({
    where: { id: input.userId },
    select: { locale: true },
  });
  const started = input.now.getTime() >= input.startTs.getTime();
  // Two literal lookups rather than one with a conditional key: the catalogue
  // guardrails find a key by reading the call, and a ternary hides both.
  const message = started
    ? await translateFor(account?.locale, 'bookingRules.cancellationStarted')
    : await translateFor(account?.locale, 'bookingRules.cancellationCutoffPassed', {
        hours: input.cutoffHours,
      });
  return new CancellationCutoffPassedError(
    message,
    playerCancellableUntil(input.startTs, input.cutoffHours),
  );
}

// ─── The club's setting ─────────────────────────────────────────────

export class InvalidCancellationCutoffError extends Error {
  constructor() {
    super(
      `The cancellation cutoff is a whole number of hours from 0 to ${MAX_CANCELLATION_CUTOFF_HOURS}.`,
    );
    this.name = 'InvalidCancellationCutoffError';
  }
}

/**
 * A club admin sets a venue's player-cancellation cutoff.
 *
 * The range is the database's CHECK (`venue_cancellation_cutoff_range`); it is
 * restated here so a bad value is a message rather than a constraint error.
 * Applies to bookings already made as well — the cutoff is read at the moment
 * of cancelling, like the refund policy always was — which is the club's call
 * to make and the reason the change is audited.
 */
export async function setVenueCancellationCutoff(
  db: PrismaClient,
  tenantId: string,
  input: { venueId: string; hours: number; actorUserId: string },
): Promise<void> {
  if (
    !Number.isInteger(input.hours) ||
    input.hours < 0 ||
    input.hours > MAX_CANCELLATION_CUTOFF_HOURS
  ) {
    throw new InvalidCancellationCutoffError();
  }
  if (typeof input.venueId !== 'string' || input.venueId.trim() === '') {
    throw new InvalidCancellationCutoffError();
  }

  const venue = await db.venue.findFirst({
    where: { id: input.venueId, tenantId },
    select: { id: true, cancellationCutoffHours: true },
  });
  if (!venue) throw new InvalidCancellationCutoffError();
  if (venue.cancellationCutoffHours === input.hours) return;

  await db.venue.updateMany({
    where: { id: venue.id, tenantId },
    data: { cancellationCutoffHours: input.hours },
  });

  await appendAuditEntry(db, {
    tenantId,
    actorUserId: input.actorUserId,
    actorType: 'USER',
    entity: 'Venue',
    entityId: venue.id,
    action: AUDIT_ACTIONS.VENUE_CANCELLATION_CUTOFF_CHANGED,
    details: `Player cancellation cutoff ${venue.cancellationCutoffHours}h → ${input.hours}h`,
    detailsJson: {
      category: 'venue',
      summary: 'Changed how long before the start a player may cancel in the app',
      before: { cancellationCutoffHours: venue.cancellationCutoffHours },
      after: { cancellationCutoffHours: input.hours },
    },
  });
}

// ─── Online payment ─────────────────────────────────────────────────

/** Checkout was asked of a club that takes payment at the club. */
export class OnlinePaymentDisabledError extends Error {
  constructor() {
    super('This club does not take payment online; bookings are paid at the club.');
    this.name = 'OnlinePaymentDisabledError';
  }
}

/**
 * Does this club take payment online? `VenueOrg.onlinePaymentEnabled`, off for
 * every club in the pilot. Decides whether a new booking is a PENDING hold for
 * checkout or CONFIRMED at once, and whether checkout answers at all.
 *
 * `venue_org` keys its row policy on its own id, so a handle bound to this
 * tenant reads exactly this row.
 */
export async function clubTakesOnlinePayment(db: PrismaClient, tenantId: string): Promise<boolean> {
  const club = await db.venueOrg.findUnique({
    where: { id: tenantId },
    select: { onlinePaymentEnabled: true },
  });
  return club?.onlinePaymentEnabled === true;
}
