import type { PrismaClient } from '@prisma/client';

import { assertBookingSpanValid, computeExpiresAt } from '@/lib/db/booking-invariants';
import { isExclusionViolation, isUniqueViolation } from '@/lib/db/pg-errors';

import { computeRefundAmount, hoursUntil, parsePolicy } from './refund';

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
  guestContact?: { name: string; email: string; phone?: string } | null;
  notes?: string | null;
}

export interface CreatedBooking {
  bookingId: string;
  status: 'PENDING';
  expiresAt: Date;
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

  const createdAt = new Date();
  const expiresAt = computeExpiresAt(createdAt);

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
    return {
      bookingId: replay.id,
      status: 'PENDING',
      expiresAt: replay.expiresAt ?? expiresAt,
      idempotentReplay: true,
    };
  }

  try {
    const booking = await db.booking.create({
      data: {
        tenantId,
        resourceId: input.resourceId,
        startTs: input.startTs,
        endTs: input.endTs,
        status: 'PENDING',
        totalCents: input.totalCents,
        idempotencyKey: input.idempotencyKey,
        bookedByUserId: input.bookedByUserId ?? null,
        guestName: input.guestContact?.name ?? null,
        guestEmail: input.guestContact?.email ?? null,
        guestPhone: input.guestContact?.phone ?? null,
        notes: input.notes ?? null,
        expiresAt,
      },
    });

    return {
      bookingId: booking.id,
      status: 'PENDING',
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
  refundAmountCents: number;
  reason: string;
}

export async function cancelBooking(
  db: PrismaClient,
  tenantId: string,
  input: { bookingId: string; cancelledByUserId?: string | null; reason?: string; now?: Date },
): Promise<CancelResult> {
  const now = input.now ?? new Date();

  const booking = await db.booking.findFirstOrThrow({
    where: { id: input.bookingId, tenantId },
    include: { resource: { include: { venue: true } } },
  });

  const policy = parsePolicy(booking.resource.venue.cancellationPolicyJson);
  const quote = computeRefundAmount({
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
    return await db.$transaction(async (tx) => {
      const updated = await tx.booking.updateMany({
        where: { id: booking.id, tenantId, status: { in: ['PENDING', 'CONFIRMED'] } },
        data: {
          status: 'CANCELLED',
          cancelledAt: now,
          cancellationReasonJson: { reason: input.reason ?? null, quote: { ...quote } },
        },
      });

      if (updated.count === 0) throw new BookingNotCancellableError();

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
        },
      });

      return {
        bookingId: booking.id,
        refundPercent: quote.refundPercent,
        refundAmountCents: quote.refundAmountCents,
        reason: quote.reason,
      };
    });
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
