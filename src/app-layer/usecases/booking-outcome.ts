import type { BookingStatus, PrismaClient } from '@prisma/client';

import { appendAuditEntries, appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';

/**
 * How a booking ended: it was played (COMPLETED), or nobody came (NO_SHOW).
 *
 * ═══ WHY THIS HAS TO EXIST ═══
 *
 * `createReview` accepts only a COMPLETED booking — that is its proof of
 * visit — and nothing ever set that status. `BookingStatus` has carried
 * COMPLETED and NO_SHOW since P05, the diary and the player's own list render
 * both, and the only code that ever mentioned COMPLETED read it. So no booking
 * could become reviewable, and the review system was unreachable by
 * construction rather than by any rule.
 *
 * ═══ THE OWNER'S DECISION: PRESUMED PLAYED, OVERTURNABLE BY STAFF ═══
 *
 * A CONFIRMED booking is paid for. When its end time passes, the sweep below
 * marks it COMPLETED on the presumption that it was played. Staff who saw an
 * empty court say otherwise with `markNoShow`, and NO_SHOW is not COMPLETED, so
 * it cannot be reviewed.
 *
 * Only CONFIRMED is ever completed. PENDING was never paid (the expiry sweep
 * owns it), CANCELLED did not happen, and NO_SHOW is a person's judgement that
 * a timer must not overwrite.
 */

/** One run's ceiling. A sweep is not a migration; it comes back in a minute. */
export const COMPLETE_PER_RUN = 500;

export interface CompletionResult {
  /** Ended CONFIRMED bookings the sweep found. */
  scanned: number;
  /** How many of those it actually moved. Lower when something else got there first. */
  completed: number;
  /** True when the cap was hit, so the caller knows more remain. */
  truncated: boolean;
}

/**
 * Mark every CONFIRMED booking whose end has passed as COMPLETED.
 *
 * Takes a handle the CALLER bound, and it must be a cross-tenant one: the sweep
 * runs for the whole platform, with no session and no slug. The cron route binds
 * `runAsSuperuser` around it. Bound to one tenant instead, it would quietly
 * complete that club's bookings and nobody else's.
 *
 * ═══ THE STATUS IS RE-STATED ON THE WRITE ═══
 *
 * The UPDATE carries `status: 'CONFIRMED'` again, rather than trusting the read
 * above it. Staff can mark a no-show between the two statements, and a write
 * keyed on the ids alone would then overwrite a person's NO_SHOW with the
 * timer's COMPLETED — making a booking reviewable that staff had just said was
 * never played. With the predicate, Postgres re-checks the row it is about to
 * change and skips one that moved; the loser of that race is the sweep, which
 * is the right loser.
 *
 * ═══ ONE TRANSACTION FOR THE BATCH ═══
 *
 * Unlike the expiry sweep, nothing here moves money, so there is no
 * SERIALIZABLE ledger append forcing a transaction per booking. The batch and
 * its audit rows commit together or not at all, in two statements.
 */
export async function completeEndedBookings(
  db: PrismaClient,
  opts: { now?: Date; limit?: number } = {},
): Promise<CompletionResult> {
  const now = opts.now ?? new Date();
  const limit = Math.min(opts.limit ?? COMPLETE_PER_RUN, COMPLETE_PER_RUN);

  // guardrail-allow: cross-tenant — the sweep spans every club by design and has
  // no session or slug to bind. Served by booking_status_endTs_idx (P35).
  const ended = await db.booking.findMany({
    where: { status: 'CONFIRMED', endTs: { lt: now } },
    select: { id: true },
    // Oldest first, so a backlog larger than one run drains in order rather
    // than starving whatever ended longest ago.
    orderBy: { endTs: 'asc' },
    take: limit,
  });

  if (ended.length === 0) return { scanned: 0, completed: 0, truncated: false };

  // guardrail-allow: cross-tenant — the ids above, and only while still CONFIRMED.
  const completed = await db.booking.updateManyAndReturn({
    where: { id: { in: ended.map((b) => b.id) }, status: 'CONFIRMED', endTs: { lt: now } },
    data: { status: 'COMPLETED' },
    select: { id: true, tenantId: true, endTs: true },
  });

  // Each row names its OWN tenant. This handle bypasses row security, so the
  // binding is not there to stamp one — see appendAuditEntry on RLS.
  await appendAuditEntries(
    db,
    completed.map((b) => ({
      tenantId: b.tenantId,
      actorUserId: null,
      // Nobody decided this. A timer did, on a presumption staff can overturn.
      actorType: 'SYSTEM' as const,
      entity: 'Booking',
      entityId: b.id,
      action: AUDIT_ACTIONS.BOOKING_COMPLETED,
      details: 'Booking ended; presumed played',
      detailsJson: {
        category: 'booking',
        summary: 'CONFIRMED booking passed its end time and was marked COMPLETED',
        before: { status: 'CONFIRMED' },
        after: { status: 'COMPLETED' },
        endTs: b.endTs.toISOString(),
        source: 'complete_ended_bookings',
      },
    })),
  );

  return {
    scanned: ended.length,
    completed: completed.length,
    truncated: ended.length === limit,
  };
}

/** Why staff could not mark a booking as a no-show. Each is a message key. */
export type NoShowRefusal =
  /** No such booking at this club — or another club's, which RLS makes the same thing. */
  | 'NOT_FOUND'
  /** The slot has not started. Nobody can have failed to turn up yet. */
  | 'NOT_STARTED'
  /** PENDING or CANCELLED: there was never a paid slot to miss. */
  | 'NOT_ATTENDABLE'
  | 'ALREADY_NO_SHOW'
  /** The player has reviewed the visit. See `markNoShow` for why that is final. */
  | 'REVIEWED';

const REFUSAL_MESSAGES: Record<NoShowRefusal, string> = {
  NOT_FOUND: 'Booking not found',
  NOT_STARTED: 'A booking cannot be a no-show before its start time',
  NOT_ATTENDABLE: 'Only a confirmed or completed booking can be marked as a no-show',
  ALREADY_NO_SHOW: 'This booking is already marked as a no-show',
  REVIEWED: 'The player has already reviewed this booking',
};

export class NoShowRefusedError extends Error {
  readonly code = 'no_show_refused';
  constructor(readonly reason: NoShowRefusal) {
    super(REFUSAL_MESSAGES[reason]);
    this.name = 'NoShowRefusedError';
  }
}

/** The row `markNoShow` locks. Enum and timestamp columns come back typed from `$queryRaw`. */
interface LockedBooking {
  id: string;
  status: BookingStatus;
  startTs: Date;
  bookedByUserId: string | null;
}

/**
 * Staff record that a player did not turn up.
 *
 * Accepted on a CONFIRMED booking once its start has passed — marked from the
 * desk while the court stands empty — and on a COMPLETED one, because the sweep
 * completes a booking the moment it ends and the desk is not always that quick.
 *
 * ═══ A REVIEWED BOOKING CANNOT BE MARKED ═══
 *
 * The review is the player's own claim that they were there, checked against
 * this booking. If a club could overturn it afterwards, NO_SHOW would become the
 * way to take down a bad review: mark the visit as never having happened, and
 * the proof behind the review is gone. That is the club moderating its own
 * reviews, which is exactly what the platform moderation queue exists so that
 * nobody does. A disputed visit is a moderation question, not a front-desk
 * click.
 *
 * ═══ THE ROW IS LOCKED FIRST ═══
 *
 * `FOR UPDATE` on the booking, before either check. The review write path takes
 * the same lock before it inserts, so the two cannot interleave: whichever
 * arrives second waits, and then reads the other's committed result — the review
 * sees NO_SHOW and is refused, or this sees the review and refuses. Without the
 * lock both checks can pass against the old state and the booking ends up a
 * no-show with a review hanging off it.
 *
 * Runs inside the caller's tenant binding, so RLS already confines the lock to
 * this club; `tenantId` is in the WHERE as well, for the same belt-and-braces
 * reason every repository states it.
 */
export async function markNoShow(
  db: PrismaClient,
  tenantId: string,
  input: { bookingId: string; actorUserId: string; now?: Date },
): Promise<{ bookingId: string; previousStatus: BookingStatus }> {
  const now = input.now ?? new Date();

  const [row] = await db.$queryRaw<LockedBooking[]>`
    SELECT id, status, "startTs", "bookedByUserId"
      FROM booking
     WHERE id = ${input.bookingId} AND "tenantId" = ${tenantId}
       FOR UPDATE`;

  if (!row) throw new NoShowRefusedError('NOT_FOUND');
  if (row.status === 'NO_SHOW') throw new NoShowRefusedError('ALREADY_NO_SHOW');
  if (row.status !== 'CONFIRMED' && row.status !== 'COMPLETED') {
    throw new NoShowRefusedError('NOT_ATTENDABLE');
  }
  if (row.startTs.getTime() > now.getTime()) throw new NoShowRefusedError('NOT_STARTED');

  const reviewed = await db.review.count({ where: { tenantId, bookingId: row.id } });
  if (reviewed > 0) throw new NoShowRefusedError('REVIEWED');

  await db.booking.updateMany({
    where: { id: row.id, tenantId, status: row.status },
    data: { status: 'NO_SHOW' },
  });

  // The club's running count, which the players screen already renders and
  // nothing has ever written. A guest booking has no player to count against.
  if (row.bookedByUserId) {
    await db.playerVenueRelationship.upsert({
      where: { tenantId_playerUserId: { tenantId, playerUserId: row.bookedByUserId } },
      create: { tenantId, playerUserId: row.bookedByUserId, noShowCount: 1 },
      update: { noShowCount: { increment: 1 } },
    });
  }

  await appendAuditEntry(db, {
    tenantId,
    actorUserId: input.actorUserId,
    actorType: 'USER',
    entity: 'Booking',
    entityId: row.id,
    action: AUDIT_ACTIONS.BOOKING_NO_SHOW,
    details: 'Marked as a no-show',
    detailsJson: {
      category: 'booking',
      summary: 'Staff recorded that the player did not turn up',
      before: { status: row.status },
      after: { status: 'NO_SHOW' },
    },
  });

  return { bookingId: row.id, previousStatus: row.status };
}
