import type { ReviewStatus } from '@prisma/client';

import {
  getBookingForUserAcrossClubs,
  listBookingsForUserAcrossClubs,
  readBookingPlayers,
  type BookingPlayer,
  type BookingWhen,
} from '@/app-layer/repositories/booking';
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
  /** Предстоящи or Минали (#359); omitted, every booking newest first. */
  when?: BookingWhen;
  now?: Date;
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
      items: bookings.map((b) => {
        const venueReview = reviewByVenue.get(b.resource.venue.id) ?? null;
        const viewerRole = roleOf(b, input.userId);
        return {
          ...b,
          clubSlug: slugByTenant.get(b.tenantId) ?? null,
          venueReview,
          viewerRole,
          // Decided HERE, by the rule below, so `GET /api/v1/me/bookings` and
          // the page cannot disagree about which bookings offer a review: the
          // v1 mapper copies this rather than restating the rule.
          canReview: canReview({ status: b.status, venueReview, viewerRole }),
        };
      }),
      nextCursor: page.nextCursor,
    };
  });
}

export type { BookingPlayer };

/**
 * The caller's side of a booking (#358): they booked it, or were added to it.
 * The booker cancels it; an added player may only leave.
 */
export type BookingViewerRole = 'BOOKER' | 'PARTICIPANT';

function roleOf(b: { bookedByUserId: string | null }, userId: string): BookingViewerRole {
  return b.bookedByUserId === userId ? 'BOOKER' : 'PARTICIPANT';
}

/**
 * One of the caller's own bookings, at any club, for its detail page and
 * `GET /api/v1/me/bookings/{id}` (#359). Null for an id that is not theirs,
 * whether it belongs to somebody else or to nobody: both are a 404.
 *
 * Superuser for `listMyBookings`'s reason (`booking` and `booking_participant`
 * are tenant-scoped, and no binding means "mine, at any club"), and scoped the
 * same way: the booking by `bookedByUserId` or, since #358, a participant row with
 * the caller's id, from a verified session, then only
 * rows hanging off that one booking, its club's slug, the caller's own review
 * of its venue, and the names of the people on it.
 */
export async function getMyBooking(input: { userId: string; bookingId: string }) {
  return runAsSuperuser(async (db) => {
    const b = await getBookingForUserAcrossClubs(db, input);
    if (!b) return null;

    const venueId = b.resource.venue.id;
    const viewerRole = roleOf(b, input.userId);

    const [club, review, players] = await Promise.all([
      db.venueOrg.findUnique({
        where: { id: b.tenantId },
        select: { slug: true, onlinePaymentEnabled: true },
      }),
      // guardrail-allow: cross-tenant — the caller's OWN review of this
      // booking's venue, by the session-derived authorUserId.
      db.review.findFirst({
        where: { authorUserId: input.userId, venueId },
        select: { id: true, bookingId: true, rating: true, status: true },
      }),
      // Names and avatars, never emails or ids: `User` is global, and this is
      // the only thing about another person a booking shows (#358).
      readBookingPlayers(db, b, input.userId),
    ]);

    const venueReview: MyVenueReview | null = review
      ? { id: review.id, bookingId: review.bookingId, rating: review.rating, status: review.status }
      : null;

    const capacity = b.resource.capacity;
    const now = new Date();

    return {
      ...b,
      clubSlug: club?.slug ?? null,
      // A club that takes no money online is paid at the club, which is every
      // pilot club (#354). A club gone from under its booking is treated the
      // same: there is nothing online to point at.
      payAtClub: !club?.onlinePaymentEnabled,
      venueReview,
      viewerRole,
      canReview: canReview({ status: b.status, venueReview, viewerRole }),
      players,
      capacity,
      // Places left for added players: the booker holds position 1.
      spotsLeft: Math.max(0, capacity - 1 - b.participants.length),
      // Players may be added, leave or be removed until the game starts, while
      // the booking holds its court (`booking-players`'s own rule).
      playersOpen:
        (b.status === 'PENDING' || b.status === 'CONFIRMED') && b.startTs.getTime() > now.getTime(),
    };
  });
}

export type MyBookingDetail = NonNullable<Awaited<ReturnType<typeof getMyBooking>>>;

/**
 * Whether a booking in this list can be reviewed from it.
 *
 * COMPLETED — the proof of visit — and no review of that venue yet, since a
 * second is refused (see `AlreadyReviewedError`). Offering a form that can only
 * fail would be the worst version of that rule.
 *
 * The booker's alone (#358): a review is proved by a booking the AUTHOR made
 * (`reviews.ts`), so an added player would be offered a form that can only
 * fail. Reviews by added players are a follow-up.
 */
export function canReview(b: {
  status: string;
  venueReview: MyVenueReview | null;
  viewerRole?: BookingViewerRole;
}): boolean {
  return (
    (b.viewerRole ?? 'BOOKER') === 'BOOKER' && b.status === 'COMPLETED' && b.venueReview === null
  );
}
