import type { PrismaClient, ReviewStatus } from '@prisma/client';

import { isUniqueViolation } from '@/lib/db/pg-errors';
import { moderateOrQueue, type ModerationResult } from '@/lib/moderation/classify';
import { assertValidRating, bayesianAverageFromTotals } from '@/lib/ratings/score';
import { sanitizePlainText } from '@/lib/security/sanitize';

/**
 * Reviews.
 *
 * Two rules do all the work here:
 *
 *   1. You may only review a booking you actually COMPLETED.
 *   2. Nothing is visible until moderation has passed on it.
 *
 * And one the schema adds: one review per venue per person — see
 * `AlreadyReviewedError` for what happens on a second visit.
 */

export class NoProofOfVisitError extends Error {
  readonly code = 'no_proof_of_visit';
  constructor() {
    super('You can only review a venue you have actually played at.');
    this.name = 'NoProofOfVisitError';
  }
}

/**
 * The author has already reviewed this venue.
 *
 * ═══ A SECOND VISIT IS REFUSED, NOT TREATED AS AN EDIT ═══
 *
 * `@@unique([venueId, authorUserId])` means a player's second completed booking
 * at the same venue cannot carry a second review. The owner left the behaviour
 * open: refuse it, or treat it as an edit of the first and moderate it again.
 *
 * It is refused, because an edit is not a small thing here:
 *
 *   • editing a PUBLISHED review sends it back to the queue, so the venue's
 *     score silently drops it for as long as a human takes to look;
 *   • editing a REJECTED one is a way around a moderator's decision — resubmit
 *     until something gets through;
 *   • an OPEN case would then describe text that no longer exists, and the
 *     partial unique index allows only one open case per review.
 *
 * Each of those has an answer, and together they are their own change. Refusing
 * is the conservative default and it is additive to lift: nothing written under
 * it needs migrating when edits arrive. The player's list does not offer the
 * form for a venue they have already reviewed, so this is reached by a race or
 * by the API, and it says plainly why.
 */
export class AlreadyReviewedError extends Error {
  readonly code = 'already_reviewed';
  constructor() {
    super('You have already reviewed this venue.');
    this.name = 'AlreadyReviewedError';
  }
}

export const REVIEW_MAX_LENGTH = 2000;

/**
 * Opens ONE tenant-bound transaction and runs `fn` inside it.
 *
 * A route passes `(fn) => inTenant(ctx, fn)`; a server action passes
 * `(fn) => runInTenantContext(tenantId, fn)`.
 *
 * ═══ WHY A RUNNER, NOT A HANDLE ═══
 *
 * Moderation is an HTTP call to the Claude API with a ten-second timeout, and it
 * has to happen before the write. Handed a transaction, that call would sit
 * INSIDE it: a pooled connection held idle for up to ten seconds per review —
 * PgBouncer runs in transaction mode, so a whole server connection — and past
 * Prisma's five-second interactive-transaction limit, so a slow classifier
 * would answer and the write would then fail on a closed transaction. With a
 * runner this opens two short transactions and the network call spans neither.
 */
export type TenantRunner = <T>(fn: (db: PrismaClient) => Promise<T>) => Promise<T>;

export interface CreatedReview {
  id: string;
  bookingId: string;
  venueId: string;
  rating: number;
  body: string | null;
  status: ReviewStatus;
  createdAt: Date;
}

/** A star rating with no text has nothing to moderate. */
const STAR_ONLY: ModerationResult = { decision: 'APPROVED', maxScore: 0, reason: null, scores: {} };

/**
 * Leave a review of the venue a booking was at.
 *
 * The venue is DERIVED from the booking, never supplied. There is nothing for a
 * caller to point elsewhere: the review lands on the venue whose court was
 * booked, so "book a €5 court at A and use it to review B" is not a check that
 * could be forgotten — it is not expressible.
 *
 * ─── Proof of visit ──────────────────────────────────────────────────
 *
 * The booking must exist at this club, belong to the author, and be COMPLETED.
 * Drop any one and the review box becomes an open comment field:
 *
 *   • no booking check   → a rival club leaves one-stars from a burner account;
 *   • no author check    → I review your booking;
 *   • no COMPLETED check → I book, review, cancel, repeat.
 *
 * The last is the sneaky one. A PENDING booking costs nothing to create and
 * nothing to abandon. COMPLETED is set by the completion sweep once a CONFIRMED
 * booking ends, and a no-show recorded by staff is never COMPLETED.
 *
 * ─── Three steps, two transactions ───────────────────────────────────
 *
 *   1. check — proof of visit, and not already reviewed. BEFORE the classifier,
 *      which costs tokens; a refusal should not.
 *   2. moderate — outside any transaction. See `TenantRunner`.
 *   3. write — the checks again, under a row lock, because the world had up to
 *      ten seconds to move: staff can mark the booking a no-show while the
 *      classifier is thinking, and `markNoShow` takes the same lock.
 */
export async function createReview(
  run: TenantRunner,
  input: {
    tenantId: string;
    bookingId: string;
    authorUserId: string;
    rating: number;
    body?: string | null;
  },
  moderate: (text: string) => Promise<ModerationResult> = moderateOrQueue,
): Promise<CreatedReview> {
  assertValidRating(input.rating);

  // Sanitise on the way IN. A review body is free text that a stranger's
  // browser will render.
  const clean = input.body ? sanitizePlainText(input.body).slice(0, REVIEW_MAX_LENGTH) : '';
  const text = clean.trim().length > 0 ? clean : null;

  await run(async (db) => {
    const booking = await lockReviewableBooking(db, input);
    await assertNotYetReviewed(db, { ...input, venueId: booking.venueId });
  });

  // Moderate BEFORE the write, so the row is never briefly live-and-unchecked.
  // `moderateOrQueue` cannot throw and cannot return APPROVED for text it failed
  // to classify — an outage sends it to a human, not to the front page.
  const verdict = text ? await moderate(text) : STAR_ONLY;

  const status: ReviewStatus =
    verdict.decision === 'APPROVED'
      ? 'PUBLISHED'
      : verdict.decision === 'REJECTED'
        ? 'REJECTED'
        : 'PENDING_REVIEW';

  return run(async (db) => {
    const booking = await lockReviewableBooking(db, input);
    await assertNotYetReviewed(db, { ...input, venueId: booking.venueId });

    let created;
    try {
      created = await db.review.create({
        data: {
          tenantId: input.tenantId,
          venueId: booking.venueId,
          authorUserId: input.authorUserId,
          bookingId: booking.id,
          rating: input.rating,
          body: text,
          status,
          moderationScoresJson: verdict.scores,
        },
      });
    } catch (err) {
      // Two submissions for two different bookings at the same venue both
      // passed the check above; the unique index is what arbitrates, and the
      // loser is told why rather than handed a 500. The violation has already
      // aborted this transaction, so throwing is also what rolls it back.
      if (isUniqueViolation(err)) throw new AlreadyReviewedError();
      throw err;
    }

    // Anything not cleanly approved gets a case. Including REJECTED: an
    // automated rejection a human never sees is an automated rejection nobody
    // can appeal.
    if (verdict.decision !== 'APPROVED') {
      await db.moderationCase.create({
        data: {
          tenantId: input.tenantId,
          subjectType: 'REVIEW',
          subjectId: created.id,
          reason: verdict.reason ?? 'unknown',
          scoresJson: verdict.scores,
          status: 'OPEN',
        },
      });
    }

    // Only a PUBLISHED review counts toward the score, and it counts in the
    // same transaction that publishes it — the review and the number it moves
    // commit together or not at all. A pending one must not move the average
    // while a human is still deciding whether it is real.
    if (status === 'PUBLISHED') {
      await recomputeVenueRating(db, { tenantId: input.tenantId, venueId: booking.venueId });
    }

    return {
      id: created.id,
      bookingId: booking.id,
      venueId: booking.venueId,
      rating: created.rating,
      body: created.body,
      status: created.status,
      createdAt: created.createdAt,
    };
  });
}

/**
 * The booking, locked, if and only if it proves the visit.
 *
 * `FOR UPDATE OF b` so a concurrent `markNoShow` and this cannot interleave: if
 * staff hold the row, this waits, and Postgres then re-checks
 * `status = 'COMPLETED'` against the row as they left it — a booking they just
 * marked NO_SHOW no longer matches, and the review is refused.
 */
async function lockReviewableBooking(
  db: PrismaClient,
  input: { tenantId: string; bookingId: string; authorUserId: string },
): Promise<{ id: string; venueId: string }> {
  const [row] = await db.$queryRaw<Array<{ id: string; venueId: string }>>`
    SELECT b.id, c."venueId"
      FROM booking b
      JOIN court c ON c.id = b."resourceId"
     WHERE b.id = ${input.bookingId}
       AND b."tenantId" = ${input.tenantId}
       AND b."bookedByUserId" = ${input.authorUserId}
       AND b.status = 'COMPLETED'
       FOR UPDATE OF b`;

  if (!row) throw new NoProofOfVisitError();
  return row;
}

async function assertNotYetReviewed(
  db: PrismaClient,
  input: { tenantId: string; venueId: string; authorUserId: string },
): Promise<void> {
  const existing = await db.review.findFirst({
    where: { tenantId: input.tenantId, venueId: input.venueId, authorUserId: input.authorUserId },
    select: { id: true },
  });
  if (existing) throw new AlreadyReviewedError();
}

/**
 * Recompute a venue's displayed score from its PUBLISHED reviews.
 *
 * Recomputed from the full set rather than incrementally adjusted. An
 * incremental update (`avg = (avg*n + r)/(n+1)`) drifts, cannot handle a review
 * being taken down by a moderator, and has no way to be repaired — the number
 * is simply wrong and nothing can tell you so. Recomputing is cheap and always
 * correct.
 *
 * ═══ "ALWAYS CORRECT" NEEDS THE LOCK ═══
 *
 * Without it, two reviews published at once at one venue each aggregate a
 * snapshot that cannot see the other's uncommitted row, and whichever UPDATE
 * lands second writes a count that is one short — and stays short until the
 * next review happens along, which at a small club may be never. Locking the
 * venue row first makes the second recompute wait, and under READ COMMITTED
 * its aggregate then runs on a fresh snapshot that includes the first.
 *
 * Call it inside the transaction that changed the review, so the change and the
 * number commit together.
 */
export async function recomputeVenueRating(
  db: PrismaClient,
  input: { tenantId: string; venueId: string },
): Promise<{ avgRating: number; reviewCount: number }> {
  await db.$queryRaw`
    SELECT id FROM venue WHERE id = ${input.venueId} AND "tenantId" = ${input.tenantId} FOR UPDATE`;

  // AGGREGATE, not findMany. The average is a function of only the sum and the
  // count, so fetching every review row buys nothing — and a club with a
  // hundred thousand reviews would load all of them into memory to compute one
  // number.
  const totals = await db.review.aggregate({
    where: { tenantId: input.tenantId, venueId: input.venueId, status: 'PUBLISHED' },
    _sum: { rating: true },
    _count: true,
  });

  const count = totals._count;

  // No reviews is not a score. `bayesianAverageFromTotals(0, 0)` is the PRIOR —
  // 4.0 — which would print a rating on a venue nobody has rated, and differ
  // from a never-reviewed venue, which the column default leaves at 0. The v1
  // contract says it outright: VenueSummary.avgRating is "0 when there are no
  // reviews". Reached whenever a moderator takes down a venue's only review.
  const avgRating = count === 0 ? 0 : bayesianAverageFromTotals(totals._sum.rating ?? 0, count);

  await db.venue.updateMany({
    where: { id: input.venueId, tenantId: input.tenantId },
    data: { avgRating, reviewCount: count },
  });

  return { avgRating, reviewCount: count };
}

/** A human resolves a case. */
export async function resolveCase(
  db: PrismaClient,
  input: {
    caseId: string;
    moderatorUserId: string;
    approve: boolean;
    note?: string;
  },
): Promise<void> {
  const c = await db.moderationCase.findUniqueOrThrow({ where: { id: input.caseId } });

  await db.$transaction(async (tx) => {
    await tx.moderationCase.update({
      where: { id: c.id },
      data: {
        status: input.approve ? 'APPROVED' : 'REJECTED',
        resolvedByUserId: input.moderatorUserId,
        resolvedAt: new Date(),
        resolutionNote: input.note ?? null,
      },
    });

    if (c.subjectType === 'REVIEW') {
      await tx.review.update({
        where: { id: c.subjectId },
        data: { status: input.approve ? 'PUBLISHED' : 'REJECTED' },
      });
    }
  });

  // The score has to move when a moderator publishes or hides a review —
  // otherwise moderation has no effect on the thing reviews exist to produce.
  if (c.subjectType === 'REVIEW' && c.tenantId) {
    const review = await db.review.findFirst({
      where: { id: c.subjectId, tenantId: c.tenantId },
    });
    if (review) {
      await recomputeVenueRating(db, { tenantId: c.tenantId, venueId: review.venueId });
    }
  }
}

/**
 * A user reports something.
 *
 * Reporting opens ONE case per subject however many people report it. Ten
 * reports on one review is one job for a moderator — and without that, a
 * coordinated group can bury the queue in duplicates of a single item and
 * everything else in it goes unlooked-at.
 */
export async function reportContent(
  db: PrismaClient,
  input: {
    tenantId?: string;
    subjectType: 'REVIEW' | 'CHAT_MESSAGE' | 'PROFILE';
    subjectId: string;
    reporterUserId: string;
    reason: string;
  },
): Promise<{ caseId: string }> {
  // One report per person per item. `createMany({skipDuplicates})` rather than
  // `create()`: a unique violation would ABORT the transaction, and reporting
  // the same thing twice is not an error worth a 500.
  await db.contentReport.createMany({
    data: [
      {
        tenantId: input.tenantId ?? null,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        reporterUserId: input.reporterUserId,
        reason: sanitizePlainText(input.reason).slice(0, 500),
      },
    ],
    skipDuplicates: true,
  });

  // ═══ CHECK-THEN-INSERT IS WRONG HERE, FOR THE SAME REASON IT IS WRONG
  //     FOR BOOKINGS ═══
  //
  // The previous shape was `findFirst` then `create`. Ten people reporting
  // the same review at once all read "no open case", all ten insert, and the
  // partial unique index rejects nine of them with a 23505 that reaches the
  // reporter as a 500. The test named "ten people reporting one review is ONE
  // job for a moderator" is precisely that scenario, and it failed
  // intermittently on main — passing whenever the ten requests happened not
  // to interleave, which is the worst possible kind of green.
  //
  // `createMany` with `skipDuplicates` compiles to INSERT ... ON CONFLICT DO
  // NOTHING. The database arbitrates instead of us, exactly as the
  // contentReport insert above already does, and unlike a caught exception it
  // does NOT abort the surrounding transaction — a violation inside a
  // transaction poisons it, so the obvious catch-and-re-read recovery would
  // throw a second, more confusing error on top of the first.
  //
  // The index is partial (WHERE status = 'OPEN'), so closing a case correctly
  // allows a new one to be opened for the same subject later.
  await db.moderationCase.createMany({
    data: [
      {
        tenantId: input.tenantId ?? null,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        reason: 'user_report',
        status: 'OPEN',
      },
    ],
    skipDuplicates: true,
  });

  // Whether we inserted or lost the race, the open case now exists and this
  // read returns the one winner — which is the point: ten reports, one job.
  //
  // It throws rather than returning null if somehow neither happened. The one
  // way that could occur is a pre-existing wrinkle, unchanged by this fix: the
  // partial index keys on (subjectType, subjectId) WITHOUT tenantId, so an
  // open case belonging to another tenant would block the insert and then not
  // match this read. Throwing is right — returning the other tenant's case id
  // would be a cross-tenant leak, and silently returning null would hide it.
  const openCase = await db.moderationCase.findFirstOrThrow({
    where: {
      tenantId: input.tenantId ?? null,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      status: 'OPEN',
    },
  });

  return { caseId: openCase.id };
}
