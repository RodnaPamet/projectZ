import type { PrismaClient, ReviewStatus } from '@prisma/client';

import { moderateOrQueue } from '@/lib/moderation/classify';
import { assertValidRating, bayesianAverageFromTotals } from '@/lib/ratings/score';
import { sanitizePlainText } from '@/lib/security/sanitize';

/**
 * Reviews.
 *
 * Two rules do all the work here:
 *
 *   1. You may only review a booking you actually COMPLETED.
 *   2. Nothing is visible until moderation has passed on it.
 */

export class NoProofOfVisitError extends Error {
  readonly code = 'no_proof_of_visit';
  constructor() {
    super('You can only review a venue you have actually played at.');
    this.name = 'NoProofOfVisitError';
  }
}

export const REVIEW_MAX_LENGTH = 2000;

/**
 * Leave a review.
 *
 * ─── Proof of visit ──────────────────────────────────────────────────
 *
 * The booking must exist, belong to the author, be at the venue being reviewed,
 * and be COMPLETED. All four, checked in one query.
 *
 * Drop any one of them and the review box becomes an open comment field:
 *
 *   • no booking check   → a rival club leaves one-stars from a burner account;
 *   • no author check    → I review your booking;
 *   • no venue check     → I book a €5 court at venue A and use it to review B;
 *   • no COMPLETED check → I book, review, cancel, repeat.
 *
 * The last one is the sneaky one. A PENDING booking costs nothing to create and
 * nothing to abandon.
 */
export async function createReview(
  db: PrismaClient,
  input: {
    tenantId: string;
    venueId: string;
    authorUserId: string;
    bookingId: string;
    rating: number;
    body?: string;
  },
): Promise<{ id: string; status: ReviewStatus }> {
  assertValidRating(input.rating);

  const booking = await db.booking.findFirst({
    where: {
      id: input.bookingId,
      tenantId: input.tenantId,
      bookedByUserId: input.authorUserId,
      status: 'COMPLETED',
      resource: { venueId: input.venueId },
    },
  });

  if (!booking) throw new NoProofOfVisitError();

  // Sanitise on the way IN. A review body is free text that a stranger's
  // browser will render.
  const clean = input.body ? sanitizePlainText(input.body).slice(0, REVIEW_MAX_LENGTH) : null;

  // Moderate BEFORE the write, so the row is never briefly live-and-unchecked.
  // `moderateOrQueue` cannot throw and cannot return APPROVED for text it
  // failed to classify — an outage sends it to a human, not to the front page.
  const verdict =
    clean && clean.trim().length > 0
      ? await moderateOrQueue(clean)
      : // A star rating with no text has nothing to moderate.
        ({ decision: 'APPROVED', maxScore: 0, reason: null, scores: {} } as const);

  const status: ReviewStatus =
    verdict.decision === 'APPROVED'
      ? 'PUBLISHED'
      : verdict.decision === 'REJECTED'
        ? 'REJECTED'
        : 'PENDING_REVIEW';

  const review = await db.$transaction(async (tx) => {
    const created = await tx.review.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        authorUserId: input.authorUserId,
        bookingId: input.bookingId,
        rating: input.rating,
        body: clean,
        status,
        moderationScoresJson: verdict.scores,
      },
    });

    // Anything not cleanly approved gets a case. Including REJECTED: an
    // automated rejection a human never sees is an automated rejection nobody
    // can appeal.
    if (verdict.decision !== 'APPROVED') {
      await tx.moderationCase.create({
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

    return created;
  });

  // Only a PUBLISHED review counts toward the score. A pending one must not
  // move the average while a human is still deciding whether it is real.
  if (status === 'PUBLISHED') {
    await recomputeVenueRating(db, { tenantId: input.tenantId, venueId: input.venueId });
  }

  return { id: review.id, status };
}

/**
 * Recompute a venue's displayed score from its PUBLISHED reviews.
 *
 * Recomputed from the full set rather than incrementally adjusted. An
 * incremental update (`avg = (avg*n + r)/(n+1)`) drifts, cannot handle a review
 * being taken down by a moderator, and has no way to be repaired — the number
 * is simply wrong and nothing can tell you so. Recomputing is cheap and always
 * correct.
 */
export async function recomputeVenueRating(
  db: PrismaClient,
  input: { tenantId: string; venueId: string },
): Promise<{ avgRating: number; reviewCount: number }> {
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
  const avgRating = bayesianAverageFromTotals(totals._sum.rating ?? 0, count);

  await db.venue.update({
    where: { id: input.venueId },
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
