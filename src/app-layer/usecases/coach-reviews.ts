import type { PrismaClient, ReviewStatus } from '@prisma/client';

import { locate } from '@/app-layer/usecases/booking-players';
import { NO_RATING, readCoachRatings, type CoachRating } from '@/app-layer/usecases/coach-ratings';
import { reportReason, type ReportInput } from '@/app-layer/usecases/messaging';
import { reportContent } from '@/app-layer/usecases/reviews';
import { COACH_REVIEW_MAX_LENGTH, shortName } from '@/lib/coaches/reviews';
import { runAsSuperuser, runInTenantContext } from '@/lib/db/rls-middleware';
import { isUniqueViolation } from '@/lib/db/pg-errors';
import { moderateOrQueue, type ModerationResult } from '@/lib/moderation/classify';
import { assertValidRating } from '@/lib/ratings/score';
import { sanitizePlainText } from '@/lib/security/sanitize';

/**
 * COACH REVIEWS (#551; owner decisions 16, 24–27 on #377).
 *
 *   who      every player with an account who was on a lesson the coach
 *            taught, once the lesson is COMPLETED (25); never the coach
 *   how many ONE per coach per player, as venues have (24): a second is
 *            refused, and there is no edit. Deleting one's own frees the
 *            place, and a new one is moderated again
 *   shown    on the coach's page, PUBLISHED only, newest first, the author as
 *            first name and initial (26), with the weighted average venues
 *            use and the count (27)
 *   checked  as venue reviews are (`reviews.ts`): the classifier before the
 *            write, a case for anything it did not clearly pass, a report
 *            opens one case however many report it
 *
 * The coach cannot remove a review. They can report one, as anybody can.
 *
 * A review is a club's row (`tenantId` is the lesson's club, for the tenant
 * policy and for its moderation case), but a coach teaches at several clubs
 * and their page shows every club's reviews; those reads say so where they
 * cross clubs.
 */

export { COACH_REVIEW_MAX_LENGTH };
/** Reviews on one page of the coach's list. */
export const COACH_REVIEWS_PAGE = 10;

/** Not a completed lesson the caller was on. Somebody else's booking looks the same. */
export class NoLessonToReviewError extends Error {
  constructor() {
    super('You can review a coach after a lesson with them is over.');
    this.name = 'NoLessonToReviewError';
  }
}

/** One review per coach per player (decision 24). */
export class CoachAlreadyReviewedError extends Error {
  constructor() {
    super('You have already reviewed this coach.');
    this.name = 'CoachAlreadyReviewedError';
  }
}

/** No such review that the caller may act on. */
export class CoachReviewNotFoundError extends Error {
  constructor() {
    super('No such review.');
    this.name = 'CoachReviewNotFoundError';
  }
}

/** A person cannot report their own review; they can delete it. */
export class OwnCoachReviewReportError extends Error {
  constructor() {
    super('You cannot report your own review.');
    this.name = 'OwnCoachReviewReportError';
  }
}

export interface CreatedCoachReview {
  id: string;
  bookingId: string;
  coachUserId: string;
  rating: number;
  body: string | null;
  status: ReviewStatus;
  createdAt: Date;
}

/** A star rating with no text has nothing to moderate. */
const STAR_ONLY: ModerationResult = { decision: 'APPROVED', maxScore: 0, reason: null, scores: {} };

/**
 * The lesson on this booking, locked, if and only if it proves the caller was
 * taught: the booking is COMPLETED (a no-show never is), the caller booked it
 * or was on it, and it is somebody else's lesson. `FOR UPDATE OF b` so a
 * no-show marked while the classifier thinks is seen by the second check.
 */
async function lockReviewableLesson(
  db: PrismaClient,
  input: { tenantId: string; bookingId: string; authorUserId: string },
): Promise<{ lessonId: string; coachUserId: string }> {
  const [row] = await db.$queryRaw<Array<{ lessonId: string; coachUserId: string }>>`
    SELECT l.id AS "lessonId", l."coachUserId"
      FROM booking b
      JOIN coach_lesson l ON l."bookingId" = b.id AND l."tenantId" = b."tenantId"
     WHERE b.id = ${input.bookingId}
       AND b."tenantId" = ${input.tenantId}
       AND b.status = 'COMPLETED'
       AND l."coachUserId" <> ${input.authorUserId}
       AND (
             b."bookedByUserId" = ${input.authorUserId}
          OR EXISTS (
               SELECT 1 FROM booking_participant p
                WHERE p."bookingId" = b.id AND p."userId" = ${input.authorUserId}
             )
           )
       FOR UPDATE OF b`;
  if (!row) throw new NoLessonToReviewError();
  return row;
}

/**
 * Whether the caller already reviewed this coach, at ANY club: the one-per-
 * coach rule is about the person, not the club. Before the classifier, which
 * costs tokens; the unique index is what finally decides.
 */
async function hasReviewed(authorUserId: string, coachUserId: string): Promise<boolean> {
  // guardrail-allow: cross-tenant — the caller's OWN reviews of one coach, at
  // every club the coach teaches at; both filters are fixed by the caller.
  const n = await runAsSuperuser((db) =>
    db.coachReview.count({ where: { authorUserId, coachUserId } }),
  );
  return n > 0;
}

/**
 * Review the coach of a lesson the caller was on (#551). The coach is DERIVED
 * from the booking, never supplied: there is no way to point a lesson with one
 * coach at another.
 *
 * Two short transactions with the classifier between them, as `createReview`
 * does for venues (see `TenantRunner` there for why).
 */
export async function createCoachReview(
  input: { authorUserId: string; bookingId: string; rating: number; body?: string | null },
  moderate: (text: string) => Promise<ModerationResult> = moderateOrQueue,
): Promise<CreatedCoachReview> {
  assertValidRating(input.rating);
  const clean = input.body ? sanitizePlainText(input.body).slice(0, COACH_REVIEW_MAX_LENGTH) : '';
  const text = clean.trim().length > 0 ? clean.trim() : null;

  const at = await locate(input.authorUserId, input.bookingId);
  if (!at) throw new NoLessonToReviewError();
  const scope = { ...input, tenantId: at.tenantId };

  const { coachUserId } = await runInTenantContext(at.tenantId, (db) =>
    lockReviewableLesson(db, scope),
  );
  if (await hasReviewed(input.authorUserId, coachUserId)) throw new CoachAlreadyReviewedError();

  // Moderated BEFORE the write, so the row is never briefly live and
  // unchecked. `moderateOrQueue` sends an outage to a human, never to the page.
  const verdict = text ? await moderate(text) : STAR_ONLY;
  const status: ReviewStatus =
    verdict.decision === 'APPROVED'
      ? 'PUBLISHED'
      : verdict.decision === 'REJECTED'
        ? 'REJECTED'
        : 'PENDING_REVIEW';

  return runInTenantContext(at.tenantId, async (db) => {
    const lesson = await lockReviewableLesson(db, scope);
    let created;
    try {
      created = await db.coachReview.create({
        data: {
          tenantId: at.tenantId,
          lessonId: lesson.lessonId,
          coachUserId: lesson.coachUserId,
          authorUserId: input.authorUserId,
          rating: input.rating,
          body: text,
          status,
          moderationScoresJson: verdict.scores,
        },
        select: { id: true, rating: true, body: true, status: true, createdAt: true },
      });
    } catch (err) {
      // Two reviews of one coach at once, from two lessons (or two clubs):
      // the unique index arbitrates, and the loser is told why.
      if (isUniqueViolation(err)) throw new CoachAlreadyReviewedError();
      throw err;
    }
    // Anything not cleanly passed gets a case, a rejection included: one a
    // human never sees is one nobody can appeal.
    if (verdict.decision !== 'APPROVED') {
      await db.moderationCase.create({
        data: {
          tenantId: at.tenantId,
          subjectType: 'COACH_REVIEW',
          subjectId: created.id,
          reason: verdict.reason ?? 'unknown',
          scoresJson: verdict.scores,
          status: 'OPEN',
        },
      });
    }
    return { ...created, bookingId: input.bookingId, coachUserId: lesson.coachUserId };
  });
}

/** The caller's own reviews of these coaches, by coach. */
export async function myCoachReviews(
  authorUserId: string,
  coachUserIds: readonly string[],
): Promise<Map<string, { id: string; rating: number; status: ReviewStatus }>> {
  const ids = [...new Set(coachUserIds)];
  if (ids.length === 0) return new Map();
  // guardrail-allow: cross-tenant — the caller's OWN reviews, at every club.
  const rows = await runAsSuperuser((db) =>
    db.coachReview.findMany({
      where: { authorUserId, coachUserId: { in: ids } },
      select: { id: true, coachUserId: true, rating: true, status: true },
      take: ids.length,
    }),
  );
  return new Map(
    rows.map((r) => [r.coachUserId, { id: r.id, rating: r.rating, status: r.status }]),
  );
}

/**
 * Delete one's own review, whatever its status. An open case about it is
 * closed with it: there is nothing left to judge.
 */
export async function deleteMyCoachReview(userId: string, reviewId: string): Promise<void> {
  // guardrail-allow: cross-tenant — which club one of the caller's OWN reviews is at.
  const row = await runAsSuperuser((db) =>
    db.coachReview.findFirst({
      where: { id: reviewId, authorUserId: userId },
      select: { tenantId: true },
    }),
  );
  if (!row) throw new CoachReviewNotFoundError();
  await runInTenantContext(row.tenantId, async (db) => {
    await db.coachReview.deleteMany({ where: { id: reviewId, authorUserId: userId } });
    await db.moderationCase.updateMany({
      where: {
        tenantId: row.tenantId,
        subjectType: 'COACH_REVIEW',
        subjectId: reviewId,
        status: 'OPEN',
      },
      data: {
        status: 'REJECTED',
        resolvedAt: new Date(),
        resolutionNote: 'Deleted by its author before a decision.',
      },
    });
  });
}

/**
 * Report a review on a coach's page (#551): one case however many report it,
 * into the platform's queue. Only a PUBLISHED review can be seen, so only one
 * can be reported; one's own is deleted, not reported.
 */
export async function reportCoachReview(
  input: { reporterUserId: string; reviewId: string } & ReportInput,
): Promise<{ reported: true }> {
  // guardrail-allow: cross-tenant — one published review, as the coach's
  // public page shows it, and the one case about it in the platform's queue.
  await runAsSuperuser(async (db) => {
    const review = await db.coachReview.findFirst({
      where: { id: input.reviewId, status: 'PUBLISHED' },
      select: { tenantId: true, authorUserId: true },
    });
    if (!review) throw new CoachReviewNotFoundError();
    if (review.authorUserId === input.reporterUserId) throw new OwnCoachReviewReportError();
    await reportContent(db, {
      tenantId: review.tenantId,
      subjectType: 'COACH_REVIEW',
      subjectId: input.reviewId,
      reporterUserId: input.reporterUserId,
      reason: reportReason(input),
    });
  });
  return { reported: true };
}

// ─── What the coach's page shows ─────────────────────────────────────────

export { NO_RATING, readCoachRatings, type CoachRating };

/** The approved coach at this public address; null for anybody else. */
export async function approvedCoachId(slug: string): Promise<string | null> {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) return null;
  // guardrail-allow: cross-tenant — one approved profile by its public address.
  const profile = await runAsSuperuser((db) =>
    db.coachProfile.findFirst({ where: { slug, status: 'APPROVED' }, select: { userId: true } }),
  );
  return profile?.userId ?? null;
}

export interface PublicCoachReview {
  id: string;
  rating: number;
  body: string | null;
  /** «Петя И.»; null when the account has no name. */
  author: string | null;
  createdAt: Date;
  /** The viewer wrote it: they may delete it, and do not report it. */
  mine: boolean;
}

export interface CoachReviewsPage {
  rating: CoachRating;
  reviews: PublicCoachReview[];
  nextCursor: string | null;
}

/**
 * One page of a coach's PUBLISHED reviews, newest first, and their rating.
 * The coach is the one with this userId; the caller has already found them
 * by their public page address.
 */
export async function listCoachReviews(input: {
  coachUserId: string;
  viewerId: string | null;
  cursor?: string | null;
  limit?: number;
}): Promise<CoachReviewsPage> {
  const limit = Math.min(Math.max(input.limit ?? COACH_REVIEWS_PAGE, 1), 50);
  // guardrail-allow: cross-tenant — published reviews of one coach, at every
  // club; public, as the coach's page is.
  const { rows, names, rating } = await runAsSuperuser(async (db) => {
    const rows = await db.coachReview.findMany({
      where: { coachUserId: input.coachUserId, status: 'PUBLISHED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: { id: true, rating: true, body: true, authorUserId: true, createdAt: true },
      take: limit + 1,
    });
    const authorIds = [...new Set(rows.map((r) => r.authorUserId))];
    const users = await db.user.findMany({
      where: { id: { in: authorIds }, deletedAt: null },
      select: { id: true, name: true },
      take: authorIds.length,
    });
    const ratings = await readCoachRatings(db, [input.coachUserId]);
    return {
      rows,
      names: new Map(users.map((u) => [u.id, u.name])),
      rating: ratings.get(input.coachUserId) ?? NO_RATING,
    };
  });
  const page = rows.slice(0, limit);
  return {
    rating,
    reviews: page.map((r) => ({
      id: r.id,
      rating: r.rating,
      body: r.body,
      author: shortName(names.get(r.authorUserId)),
      createdAt: r.createdAt,
      mine: input.viewerId !== null && r.authorUserId === input.viewerId,
    })),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}
