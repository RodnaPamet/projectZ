import type { PrismaClient, ReviewStatus } from '@prisma/client';

import { moderationQueuePageIds, type SeekCursor } from '@/app-layer/repositories/platform-paging';

import { chatCaseItems, type ChatQueueItem } from './moderation-messages';

/**
 * The review moderation queue, as a platform moderator reads it.
 *
 * ═══ ACROSS EVERY CLUB, AND ONLY EVER FROM THE PLATFORM TREE ═══
 *
 * A case belongs to the club whose venue was reviewed, and the moderator
 * belongs to none of them: a club moderating its own reviews is exactly what
 * the queue exists to prevent. So this reads across clubs, and the handle it is
 * given must be the audited platform binding — `asPlatformAdmin` with
 * REVIEW_MODERATE, from a route under /api/v1/platform. Bound to one tenant it
 * would show that club's cases and call it the queue.
 *
 * ═══ WHAT A MODERATOR SEES ═══
 *
 * The review as its author wrote it (sanitised on the way in), the stars, the
 * venue and club it is about, why it is in the queue — a classifier category,
 * `classifier_unavailable`, or `user_report` — and the classifier's scores, so
 * the human judges the machine as well as the text. Not the author: whether a
 * review is abuse does not depend on who wrote it, and a name invites that it
 * should.
 */

export const QUEUE_PAGE_SIZE = 50;

/**
 * A case in the queue: a review, or (#375) a reported message or
 * conversation — `moderation-messages.ts` builds those.
 */
export type QueueItem = ReviewQueueItem | ChatQueueItem;

export interface ReviewQueueItem {
  subject: 'REVIEW';
  caseId: string;
  /** Why it is here: a category, `classifier_unavailable`, or `user_report`. */
  reason: string;
  openedAt: Date;
  /** Category → 0..1. Empty when no classifier ran (an outage, or a report). */
  scores: Record<string, number>;
  review: {
    id: string;
    rating: number;
    body: string | null;
    status: ReviewStatus;
    createdAt: Date;
  };
  venue: { id: string; name: string };
  club: { id: string; slug: string; name: string };
}

/** Scores as stored — `Json` — reduced to what they claim to be. */
function toScores(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * One page of OPEN cases, oldest first — the order a queue is worked in:
 * reviews, and since #375 reported messages and conversations.
 *
 * Five reads for a whole page — the ids, then cases, reviews, venues and clubs
 * by id — never one per case, and the chat cases' own handful
 * (`chatCaseItems`). Each is bounded by the page.
 *
 * `nextCursor` comes from the page's IDS, not from the items: a case whose
 * review has gone is skipped below, and a cursor taken from the last item
 * shown would re-read it and every case after it on the next page.
 */
export async function listModerationCases(
  db: PrismaClient,
  opts: { limit?: number; after?: SeekCursor } = {},
): Promise<{ items: QueueItem[]; nextCursor: string | null }> {
  const limit = opts.limit ?? QUEUE_PAGE_SIZE;
  const fetched = await moderationQueuePageIds(db, { limit, after: opts.after });
  const hasMore = fetched.length > limit;
  const ids = hasMore ? fetched.slice(0, limit) : fetched;
  const nextCursor = hasMore ? (ids.at(-1) ?? null) : null;
  if (ids.length === 0) return { items: [], nextCursor: null };

  // guardrail-allow: cross-tenant — the platform queue spans every club; this
  // handle is the audited platform binding, and the ids are the page above.
  const cases = await db.moderationCase.findMany({
    where: { id: { in: ids }, status: 'OPEN' },
    select: {
      id: true,
      tenantId: true,
      subjectType: true,
      subjectId: true,
      reason: true,
      scoresJson: true,
      createdAt: true,
    },
    take: ids.length,
  });
  const chat = await chatCaseItems(db, cases);

  // guardrail-allow: cross-tenant — the reviews those cases are about, by id.
  const reviews = await db.review.findMany({
    where: {
      id: { in: cases.flatMap((c) => (c.subjectType === 'REVIEW' ? [c.subjectId] : [])) },
    },
    select: {
      id: true,
      tenantId: true,
      venueId: true,
      rating: true,
      body: true,
      status: true,
      createdAt: true,
      moderationScoresJson: true,
    },
    take: cases.length,
  });

  const venueIds = [...new Set(reviews.map((r) => r.venueId))];
  const tenantIds = [...new Set(reviews.map((r) => r.tenantId))];

  const [venues, clubs] = await Promise.all([
    // guardrail-allow: cross-tenant — the venues those reviews are about, by id.
    // public-venue-filter: not a public read — the platform moderation queue
    // names the venue a reported review is about, whatever its club's status.
    db.venue.findMany({
      where: { id: { in: venueIds } },
      select: { id: true, name: true },
      take: venueIds.length,
    }),
    db.venueOrg.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true, slug: true, name: true },
      take: tenantIds.length,
    }),
  ]);

  const caseById = new Map(cases.map((c) => [c.id, c]));
  const reviewById = new Map(reviews.map((r) => [r.id, r]));
  const venueById = new Map(venues.map((v) => [v.id, v]));
  const clubById = new Map(clubs.map((c) => [c.id, c]));

  // Walked in the seek's order: `IN` returns rows in whatever order Postgres
  // likes, and a page sorted wrong breaks the cursor as well as the reading.
  const items: QueueItem[] = [];
  for (const id of ids) {
    const c = caseById.get(id);
    // Resolved between the id read and this one, by another moderator.
    if (!c) continue;
    if (c.subjectType !== 'REVIEW') {
      const item = chat.get(c.id);
      if (item) items.push(item);
      continue;
    }
    const review = reviewById.get(c.subjectId);
    // A case whose review has gone — the venue was deleted, and the review
    // with it by cascade — has nothing to decide. It stays OPEN in the table,
    // so it is recorded, and leaves the queue here rather than rendering blank.
    if (!review) continue;
    const venue = venueById.get(review.venueId);
    const club = clubById.get(review.tenantId);
    if (!venue || !club) continue;

    items.push({
      subject: 'REVIEW',
      caseId: c.id,
      reason: c.reason,
      openedAt: c.createdAt,
      // The case's own scores first; a user report carries none, and then the
      // classifier's verdict from when the review was written is still the
      // most useful thing to show.
      scores: toScores(c.scoresJson ?? review.moderationScoresJson),
      review: {
        id: review.id,
        rating: review.rating,
        body: review.body,
        status: review.status,
        createdAt: review.createdAt,
      },
      venue: { id: venue.id, name: venue.name },
      club: { id: club.id, slug: club.slug, name: club.name },
    });
  }

  return { items, nextCursor };
}
