import type { BookingStatus, PrismaClient } from '@prisma/client';

import { assertBookingSpanValid, computeExpiresAt } from '@/lib/db/booking-invariants';
import { isExclusionViolation, isUniqueViolation } from '@/lib/db/pg-errors';

import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { playerMayCancel } from '@/lib/booking/cutoff';

import { SlotNotBookableError } from './availability';
import {
  assertMayBookOnline,
  assertUnderOnlineBookingCap,
  cancellationCutoffError,
  lockPlayerOnlineBookings,
} from './booking-rules';
import { computeRefundAmount, hoursUntil, parsePolicy, type RefundQuote } from './refund';
import { appendEntry } from './wallet';

/**
 * The booking golden path.
 *
 * ─── The single most important design decision in this codebase ──────
 *
 * `createBooking` does NOT check whether the slot is free.
 *
 * That looks reckless and is the opposite. The check-then-insert pattern
 *
 *     const clash = await db.booking.findFirst({ ...overlapping... });
 *     if (clash) throw conflict('slot_taken');
 *     await db.booking.create({ ... });
 *
 * is WRONG under concurrency, and it is wrong in a way that testing will
 * not reveal: two requests both read "free", both insert, both succeed, and
 * the court is sold twice. It works perfectly in every test you would write
 * and fails on a busy Saturday.
 *
 * Instead we attempt the INSERT and let the Postgres EXCLUDE constraint
 * (P05, `booking_no_overlap`) arbitrate. Postgres serialises the write;
 * nothing else can. `23P01` becomes conflict('slot_taken').
 *
 * The read-before-write check would ALSO be a lie in the other direction:
 * it makes the code look like it is the safeguard, so the next person to
 * touch it "optimises away" the constraint they think is redundant.
 */

export class SlotTakenError extends Error {
  readonly code = 'slot_taken';
  constructor() {
    super('Another player just booked this slot.');
    this.name = 'SlotTakenError';
  }
}

export class GuestContactRequiredError extends Error {
  readonly code = 'guest_contact_required';
  constructor() {
    super('A booking must be attributable to someone: sign in, or provide guest contact details.');
    this.name = 'GuestContactRequiredError';
  }
}

/**
 * Two requests carrying the SAME idempotency key raced, and we lost.
 *
 * Genuinely rare — it needs two in-flight retries of the same tap. The
 * caller should re-issue the request; the pre-check will then find the
 * winner's row and return it.
 *
 * This exists because of a constraint that is easy to miss: once a
 * statement violates a constraint inside a Postgres transaction, the
 * TRANSACTION IS ABORTED and every subsequent command in it fails with
 * "current transaction is aborted". So the obvious recovery —
 * catch the unique violation, then `findUnique` the original row and return
 * it — CANNOT WORK from inside the same transaction. It throws a second,
 * more confusing error on top of the first.
 *
 * That bug would only ever appear on a real retry: the user taps "Book"
 * once, the network stalls, the app retries, and they get a 500 error page
 * while their booking actually exists.
 */
export class IdempotencyRaceError extends Error {
  readonly code = 'idempotency_race';
  constructor() {
    super('A concurrent request with the same idempotency key is in flight. Retry.');
    this.name = 'IdempotencyRaceError';
  }
}

/**
 * The booking moved out of a cancellable state before our write landed.
 *
 * This is NOT the same as "you asked to cancel something already cancelled",
 * which the route rejects from its own read. This is the narrower, nastier
 * case: the read said PENDING, and by the time the UPDATE took its row lock
 * the expiry sweeper had already released the hold.
 *
 * Getting that wrong writes a Cancellation row — a REFUND RECEIPT — against a
 * booking nobody ever paid for, which is precisely the ledger lie
 * `releaseExpiredBookings` refuses to write when it does the same job.
 */
export class BookingNotCancellableError extends Error {
  readonly code = 'booking_not_cancellable';
  constructor() {
    super('This booking is no longer cancellable: it was already cancelled, or its hold expired.');
    this.name = 'BookingNotCancellableError';
  }
}

export interface CreateBookingInput {
  resourceId: string;
  startTs: Date;
  endTs: Date;
  totalCents: number;
  idempotencyKey: string;
  bookedByUserId?: string | null;
  /**
   * Who the booking is for when it is not (only) an account. A desk booking
   * (#364) always carries the name and phone the desk took, linked or not;
   * the email is optional there, because nobody asks a walk-in for one.
   */
  guestContact?: { name: string; email?: string | null; phone?: string | null } | null;
  /** The weekly series this is an occurrence of (#364), set by `createSeries`. */
  seriesId?: string | null;
  notes?: string | null;
  /**
   * The club takes payment ONLINE (`VenueOrg.onlinePaymentEnabled`). Then the
   * booking is a PENDING hold that checkout confirms, as before #354.
   *
   * Absent or false — every club in the Sofia pilot — the booking is CONFIRMED
   * the moment it is written and paid at the club. There is no hold to expire
   * and nothing for checkout to do.
   */
  onlinePayment?: boolean;
  /**
   * Who is booking. `ONLINE` (the default) is a player in the app or on the
   * web, and is held to the pilot's rules (#354): the slot must not have
   * started, and three recent no-shows at the club refuse it. `DESK` is the
   * club booking on someone's behalf (#364) — the block is on ONLINE booking,
   * and a walk-in may well be for the hour already under way. Only ONLINE
   * counts toward, and is held to, the club's cap on upcoming online bookings
   * (#380). Written to `Booking.channel`.
   */
  channel?: 'ONLINE' | 'DESK';
  /** "Now", for the start check and the no-show window. Tests pin it. */
  now?: Date;
}

export interface CreatedBooking {
  bookingId: string;
  /** CONFIRMED or PENDING when created; whatever it is now on a replay. */
  status: BookingStatus;
  /** The hold's end for a PENDING booking; null for a confirmed one. */
  expiresAt: Date | null;
  /** True when an existing booking was returned for a repeated key. */
  idempotentReplay: boolean;
}

export async function createBooking(
  db: PrismaClient,
  tenantId: string,
  input: CreateBookingInput,
): Promise<CreatedBooking> {
  assertBookingSpanValid({ startTs: input.startTs, endTs: input.endTs });

  // A booking must be attributable to SOMEONE. Nobody to confirm, remind,
  // or refund is not a booking; it is a slot that quietly disappears.
  if (!input.bookedByUserId && !input.guestContact) {
    throw new GuestContactRequiredError();
  }

  const createdAt = input.now ?? new Date();
  const status: BookingStatus = input.onlinePayment ? 'PENDING' : 'CONFIRMED';
  const expiresAt = status === 'PENDING' ? computeExpiresAt(createdAt) : null;

  // ── Idempotency pre-check ─────────────────────────────────────────
  //
  // This is NOT the check-then-insert anti-pattern, and the difference is
  // worth being precise about:
  //
  //   - Checking whether the SLOT is free is unsafe, because between the
  //     check and the insert another transaction can take it. The EXCLUDE
  //     constraint has to arbitrate.
  //   - Checking the IDEMPOTENCY KEY is a fast path, and the unique
  //     constraint still arbitrates. Racing here costs correctness nothing:
  //     the loser gets 23505 and is told to retry.
  //
  // It has to happen BEFORE the insert because a constraint violation
  // ABORTS the surrounding Postgres transaction — recovering after the
  // failure, from inside the same transaction, is impossible.
  const replay = await db.booking.findUnique({
    where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: input.idempotencyKey } },
  });

  if (replay) {
    // The booking as it IS, not as this request would have made it: a retry
    // after the player cancelled must not read as a fresh confirmation, and
    // the route re-reads the row for the body anyway.
    return {
      bookingId: replay.id,
      status: replay.status,
      expiresAt: replay.expiresAt,
      idempotentReplay: true,
    };
  }

  // ═══ THE ONLINE RULES (#354), AFTER THE REPLAY CHECK ═══
  //
  // Deliberately after it: a retry of a booking that was made returns that
  // booking, which is what an idempotency key promises — even if the slot has
  // started by the time the retry lands, or the player has been blocked since.
  // Only a NEW booking is refused.
  const channel = input.channel ?? 'ONLINE';
  if (channel === 'ONLINE') {
    // NOT IN THE PAST. With instant confirmation a booking for a slot already
    // under way would be CONFIRMED, then COMPLETED by the sweep at its end —
    // and a COMPLETED booking is the proof of visit a review needs. Booking
    // yesterday's court would be a way to review a club you never went to.
    if (input.startTs.getTime() <= createdAt.getTime()) {
      throw new SlotNotBookableError('that time has already started');
    }

    // THE NO-SHOW BLOCK. A guest booking has no player to count against.
    if (input.bookedByUserId) {
      await assertMayBookOnline(db, tenantId, input.bookedByUserId, createdAt);

      // THE CAP ON UPCOMING ONLINE BOOKINGS (#380). A count and an INSERT, so
      // it is serialised per (club, player) by a transaction-scoped advisory
      // lock — see `lockPlayerOnlineBookings` — held until the route's
      // transaction commits this booking. A guest booking has no player to
      // count; a DESK booking or series is never capped.
      await lockPlayerOnlineBookings(db, tenantId, input.bookedByUserId);

      // The replay check again, now under the lock. A concurrent request with
      // the SAME key that committed while we waited is this request's own
      // booking: return it, rather than counting it against the cap and
      // refusing the player the booking they just made.
      const raced = await db.booking.findUnique({
        where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: input.idempotencyKey } },
      });
      if (raced) {
        return {
          bookingId: raced.id,
          status: raced.status,
          expiresAt: raced.expiresAt,
          idempotentReplay: true,
        };
      }

      await assertUnderOnlineBookingCap(db, tenantId, input.bookedByUserId, createdAt);
    }
  }

  try {
    const booking = await db.booking.create({
      data: {
        tenantId,
        resourceId: input.resourceId,
        startTs: input.startTs,
        endTs: input.endTs,
        status,
        channel,
        totalCents: input.totalCents,
        idempotencyKey: input.idempotencyKey,
        bookedByUserId: input.bookedByUserId ?? null,
        guestName: input.guestContact?.name ?? null,
        guestEmail: input.guestContact?.email ?? null,
        guestPhone: input.guestContact?.phone ?? null,
        notes: input.notes ?? null,
        seriesId: input.seriesId ?? null,
        expiresAt,
      },
    });

    return {
      bookingId: booking.id,
      status,
      expiresAt,
      idempotentReplay: false,
    };
  } catch (err) {
    // ── The slot was taken between our decision and our INSERT ────────
    if (isExclusionViolation(err)) {
      throw new SlotTakenError();
    }

    // ── Two in-flight requests carried the same idempotency key ───────
    //
    // The pre-check above handles the ordinary retry. Reaching here means a
    // genuine race, and we CANNOT recover by reading the winner's row: the
    // constraint violation has already aborted this transaction, so every
    // further command in it fails with "current transaction is aborted".
    //
    // (Learning that the hard way is what produced this comment. The
    // recovery-read version of this code threw a second, more confusing
    // error on top of the first — and only ever on a real retry.)
    if (isUniqueViolation(err)) {
      throw new IdempotencyRaceError();
    }

    throw err;
  }
}

export interface CancelResult {
  bookingId: string;
  refundPercent: number;
  /** TOTAL owed back across both legs. */
  refundAmountCents: number;
  /** The part of that total returned as wallet credit. */
  refundCreditCents: number;
  reason: string;
}

/**
 * The quote for a booking nothing was paid for online — every booking in the
 * Sofia pilot, paid at the club (#354). There is no money of the player's to
 * return, so the club's refund bands have nothing to apply to; quoting "100%,
 * €24 due" would tell the player we owe them money we never took.
 */
export const PAID_AT_CLUB_QUOTE: RefundQuote = {
  refundPercent: 0,
  refundAmountCents: 0,
  reason: 'Paid at the club; nothing was taken online',
};

/**
 * Cancel a booking, and quote what is owed back.
 *
 * ═══ WHO IS CANCELLING DECIDES WHETHER THE CUTOFF APPLIES (#354) ═══
 *
 * `actor: 'PLAYER'` — the booker, in the app — may cancel until the venue's
 * `cancellationCutoffHours` before the start, and never once it has started.
 * `actor: 'STAFF'` — the desk, holding `bookings.view_all` — may always cancel:
 * "after that only the club can cancel" is the owner's rule, and the club is
 * the desk. The route decides which from the permission, not from the body.
 *
 * ═══ THE REFUND BANDS NO LONGER DECIDE ANYTHING FOR A PILOT BOOKING ═══
 *
 * `Venue.cancellationPolicyJson` priced the refund of money taken online. With
 * payment at the club there is none, so a booking with no PAID payment and no
 * wallet spend gets `PAID_AT_CLUB_QUOTE`. A booking that was paid online — a
 * club with `onlinePaymentEnabled`, or one made before #354 — is still quoted
 * by the bands, because there the money is real.
 */
export async function cancelBooking(
  db: PrismaClient,
  tenantId: string,
  input: {
    bookingId: string;
    actor: 'PLAYER' | 'STAFF';
    cancelledByUserId?: string | null;
    reason?: string;
    now?: Date;
  },
): Promise<CancelResult> {
  const now = input.now ?? new Date();

  const booking = await db.booking.findFirstOrThrow({
    where: { id: input.bookingId, tenantId },
    include: { resource: { include: { venue: true } } },
  });

  const cutoffHours = booking.resource.venue.cancellationCutoffHours;
  if (input.actor === 'PLAYER' && !playerMayCancel(booking.startTs, cutoffHours, now)) {
    throw await cancellationCutoffError(db, {
      userId: input.cancelledByUserId ?? booking.bookedByUserId ?? '',
      startTs: booking.startTs,
      cutoffHours,
      now,
    });
  }

  const policy = parsePolicy(booking.resource.venue.cancellationPolicyJson);
  const bandQuote = computeRefundAmount({
    bookingTotalCents: booking.totalCents,
    hoursUntilStart: hoursUntil(booking.startTs, now),
    policy,
  });

  // ═══ THE STATUS IS RE-CHECKED IN THE WRITE, NOT TRUSTED FROM THE READ ═══
  //
  // The read above is for the QUOTE. It cannot also be the authorisation to
  // write, because nothing holds the row between the two — and the thing most
  // likely to move it is a cron job.
  //
  // `releaseExpiredBookings` sweeps PENDING bookings whose hold lapsed and
  // deliberately writes NO Cancellation row ("a refund receipt for money never
  // taken would be a lie in the ledger"). If the player taps Cancel in the same
  // instant, the old check-then-write would read PENDING, block on the
  // sweeper's lock, and then write CANCELLED *again* plus a receipt quoting up
  // to a full refund — for a booking that was never paid.
  //
  // So the predicate carries the status. The loser of that race updates zero
  // rows and writes nothing at all.
  try {
    return await db.$transaction(
      async (tx) => {
        // ═══ THE WALLET LEG ═══
        //
        // The receipt used to quote a refund percentage and return NOTHING of
        // the credit the player had spent. `checkoutBooking` spends the wallet
        // before charging the card, so a part-paid booking cancelled at 100%
        // gave back the card money and silently kept the credit.
        //
        // The same percentage applies to both legs. A cancellation policy is
        // about the BOOKING, not about how it happened to be paid for — and a
        // policy that returned credit in full while forfeiting card money would
        // make paying by wallet strictly better than paying by card, which is an
        // arbitrage the club did not agree to.
        //
        // Summed from the ledger rather than derived from `booking.totalCents`,
        // because only the ledger knows what was actually taken.
        const spent = await tx.creditLedgerEntry.groupBy({
          by: ['userId'],
          where: { tenantId, refType: 'booking', refId: booking.id, reason: 'SPEND' },
          _sum: { deltaCents: true },
        });

        // Was anything taken online at all? A card payment that landed, or
        // credit spent above. Neither means paid at the club: nothing to return.
        const paidOnline = await tx.payment.count({
          where: {
            tenantId,
            bookingId: booking.id,
            status: { in: ['PAID', 'PARTIALLY_REFUNDED'] },
          },
        });
        const spentAny = spent.some((row) => (row._sum.deltaCents ?? 0) !== 0);
        const quote = paidOnline > 0 || spentAny ? bandQuote : PAID_AT_CLUB_QUOTE;

        const updated = await tx.booking.updateMany({
          where: { id: booking.id, tenantId, status: { in: ['PENDING', 'CONFIRMED'] } },
          data: {
            status: 'CANCELLED',
            cancelledAt: now,
            cancellationReasonJson: { reason: input.reason ?? null, quote: { ...quote } },
          },
        });

        if (updated.count === 0) throw new BookingNotCancellableError();

        let refundCreditCents = 0;

        for (const row of spent) {
          const spentCents = Math.abs(row._sum.deltaCents ?? 0);
          if (spentCents === 0) continue;

          // Round, don't floor — the same reasoning as the card leg. Flooring
          // quietly keeps a cent of somebody's money on every odd total.
          const give = Math.round((spentCents * quote.refundPercent) / 100);
          if (give === 0) continue;

          // `tx` is a transaction client; appendEntry's signature takes the
          // full client. Cast as the RLS wrappers do — appendEntry opens its own
          // nested $transaction and verifies the isolation it actually got.
          await appendEntry(tx as unknown as PrismaClient, {
            tenantId,
            userId: row.userId,
            deltaCents: give,
            reason: 'REFUND_CREDIT',
            refType: 'booking',
            refId: booking.id,
          });

          refundCreditCents += give;
        }

        // The resolved percentage is WRITTEN DOWN, not recomputed later. The
        // venue's policy may change next month; this receipt must not.
        await tx.cancellation.create({
          data: {
            tenantId,
            bookingId: booking.id,
            cancelledByUserId: input.cancelledByUserId ?? null,
            reason: input.reason ?? null,
            refundPercent: quote.refundPercent,
            refundAmountCents: quote.refundAmountCents,
            refundCreditCents,
          },
        });

        // The record of WHO. A staff cancellation after the player's cutoff is
        // exactly the override a club will be asked about later.
        await appendAuditEntry(tx as unknown as PrismaClient, {
          tenantId,
          actorUserId: input.cancelledByUserId ?? null,
          actorType: 'USER',
          entity: 'Booking',
          entityId: booking.id,
          action: AUDIT_ACTIONS.BOOKING_CANCELLED,
          details: input.actor === 'STAFF' ? 'Cancelled by the club' : 'Cancelled by the player',
          detailsJson: {
            category: 'booking',
            summary:
              input.actor === 'STAFF'
                ? 'Staff cancelled the booking'
                : 'The player cancelled their booking',
            before: { status: booking.status },
            after: { status: 'CANCELLED' },
            actor: input.actor,
            cutoffHours,
            hoursBeforeStart: Number(hoursUntil(booking.startTs, now).toFixed(2)),
          },
        });

        return {
          bookingId: booking.id,
          refundPercent: quote.refundPercent,
          refundAmountCents: quote.refundAmountCents,
          refundCreditCents,
          reason: quote.reason,
        };
      },
      {
        // Asked for HERE, not left to the caller.
        //
        // The wallet leg goes through `appendEntry`, which refuses anything
        // weaker. When this is the outermost transaction — a script, a test, any
        // future non-route caller — this is what makes it serializable. When it
        // is nested inside `inTenant(..., { isolationLevel: 'Serializable' })`
        // the request is dropped and the outer level already holds, so asking
        // costs nothing and forgetting costs a runtime failure on the one path
        // that moves money.
        isolationLevel: 'Serializable',
      },
    );
  } catch (err) {
    // `Cancellation.bookingId` is @unique, so the database — not the route's
    // read, and not the predicate above — is what makes a second receipt
    // impossible.
    //
    // The predicate means an ordinary double-tap never gets this far. What
    // does is the inconsistent state: a receipt already on file while the
    // booking is still live. Then the UPDATE matches and the INSERT raises.
    // Unmapped, that reached the client as a 500, because only `createBooking`
    // handled unique violations.
    if (isUniqueViolation(err)) throw new BookingNotCancellableError();
    throw err;
  }
}
