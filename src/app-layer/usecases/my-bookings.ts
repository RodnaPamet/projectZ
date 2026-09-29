import type { ReviewStatus } from '@prisma/client';

import { listBookingsForUserAcrossClubs } from '@/app-layer/repositories/booking';
import { runAsSuperuser } from '@/lib/db/rls-middleware';

/**
 * A person's own bookings, at every club.
 *
 * ═══ WHY THIS BINDS SUPERUSER ═══
 *
 * `booking` carries a tenant-scoped RLS policy — `tenantId = app.tenant_id`
 * and nothing else — so there is no binding that means "mine, everywhere".
 * `asUser` binds `app.user_id`, which the booking policy does not mention, so
 * it returns ZERO ROWS: an empty page that reads as "you have no bookings"
 * rather than as a wrong binding. That failure mode is exactly what
 * `bind.ts` warns about.
 *
 * The scope is `bookedByUserId`, taken from a verified session and never from
 * the request, so there is no parameter to point somewhere else. One person's
 * own rows, by an indexed column.
 *
 * ═══ WHY NOT ONE BOUND QUERY PER CLUB ═══
 *
 * That was the alternative and it is worse in two ways. It is N transactions
 * to render one page. And the list of clubs would come from the token, whose
 * membership array is TRUNCATED at a cap — so a player with many clubs would
 * silently lose the tail of their own bookings, which is precisely the bug
 * `membershipsTruncated` exists to warn about.
 */

/** The caller's own review of a venue — at most one, by `@@unique([venueId, authorUserId])`. */
export interface MyVenueReview {
  id: string;
  /** Which of their bookings it was left against; not necessarily this one. */
  bookingId: string | null;
  rating: number;
  status: ReviewStatus;
}

export async function listMyBookings(input: {
  userId: string;
  cursor?: string | null;
  limit?: number;
}) {
  return runAsSuperuser(async (db) => {
    const page = await listBookingsForUserAcrossClubs(db, input);
    const bookings = page.items;

    if (bookings.length === 0) return { items: [], nextCursor: page.nextCursor };

    const tenantIds = [...new Set(bookings.map((b) => b.tenantId))];
    const venueIds = [...new Set(bookings.map((b) => b.resource.venue.id))];

    // Two lookups for the whole page, not one per booking. Both are bounded
    // by the page itself, and both stay inside what the caller may see: the
    // clubs of their own bookings, and reviews THEY wrote.
    const [clubs, reviews] = await Promise.all([
      // The slug, because a review is submitted to the club it belongs to and
      // the club is addressed by slug everywhere else.
      db.venueOrg.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, slug: true },
        take: tenantIds.length,
      }),
      // guardrail-allow: cross-tenant — the caller's OWN reviews, by the
      // session-derived authorUserId, at the venues already on this page.
      db.review.findMany({
        where: { authorUserId: input.userId, venueId: { in: venueIds } },
        select: { id: true, venueId: true, bookingId: true, rating: true, status: true },
        take: venueIds.length,
      }),
    ]);

    const slugByTenant = new Map(clubs.map((c) => [c.id, c.slug]));
    const reviewByVenue = new Map(
      reviews.map((r) => [
        r.venueId,
        { id: r.id, bookingId: r.bookingId, rating: r.rating, status: r.status } as MyVenueReview,
      ]),
    );

    return {
      items: bookings.map((b) => ({
        ...b,
        clubSlug: slugByTenant.get(b.tenantId) ?? null,
        venueReview: reviewByVenue.get(b.resource.venue.id) ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  });
}

/**
 * Whether a booking in this list can be reviewed from it.
 *
 * COMPLETED — the proof of visit — and no review of that venue yet, since a
 * second is refused (see `AlreadyReviewedError`). Offering a form that can only
 * fail would be the worst version of that rule.
 */
export function canReview(b: { status: string; venueReview: MyVenueReview | null }): boolean {
  return b.status === 'COMPLETED' && b.venueReview === null;
}
