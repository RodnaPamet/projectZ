import type { ReviewStatus } from '@prisma/client';

import {
  getBookingForUserAcrossClubs,
  listBookingsForUserAcrossClubs,
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
        return {
          ...b,
          clubSlug: slugByTenant.get(b.tenantId) ?? null,
          venueReview,
          // Decided HERE, by the rule below, so `GET /api/v1/me/bookings` and
          // the page cannot disagree about which bookings offer a review: the
          // v1 mapper copies this rather than restating the rule.
          canReview: canReview({ status: b.status, venueReview }),
        };
      }),
      nextCursor: page.nextCursor,
    };
  });
}

/** A person on a booking, as its detail page shows them: a name and a face. */
export interface BookingPlayer {
  /** Null for a registered player who has not set a name yet. */
  name: string | null;
  avatarUrl: string | null;
  isBooker: boolean;
  /** Registered (has an account), as opposed to a guest named by the booker. */
  registered: boolean;
}

/**
 * One of the caller's own bookings, at any club, for its detail page and
 * `GET /api/v1/me/bookings/{id}` (#359). Null for an id that is not theirs,
 * whether it belongs to somebody else or to nobody: both are a 404.
 *
 * Superuser for `listMyBookings`'s reason (`booking` and `booking_participant`
 * are tenant-scoped, and no binding means "mine, at any club"), and scoped the
 * same way: the booking by `bookedByUserId` from a verified session, then only
 * rows hanging off that one booking, its club's slug, the caller's own review
 * of its venue, and the names of the people on it.
 */
export async function getMyBooking(input: { userId: string; bookingId: string }) {
  return runAsSuperuser(async (db) => {
    const b = await getBookingForUserAcrossClubs(db, input);
    if (!b) return null;

    const venueId = b.resource.venue.id;
    // The booker first, then each participant once. Until #358 lets a booker
    // add players there are none, and the list is the booker alone.
    const userIds = [
      input.userId,
      ...b.participants.flatMap((p) => (p.userId && p.userId !== input.userId ? [p.userId] : [])),
    ];

    const [club, review, users] = await Promise.all([
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
      // Names and avatars, never emails: `User` is global, and this is the
      // only thing about another person a booking shows.
      db.user.findMany({
        where: { id: { in: [...new Set(userIds)] } },
        select: { id: true, name: true, avatarUrl: true },
        take: userIds.length,
      }),
    ]);

    const byId = new Map(users.map((u) => [u.id, u]));
    const seen = new Set<string>();
    const players: BookingPlayer[] = [];
    for (const id of userIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const u = byId.get(id);
      players.push({
        name: u?.name ?? null,
        avatarUrl: u?.avatarUrl ?? null,
        isBooker: id === input.userId,
        registered: true,
      });
    }
    for (const p of b.participants) {
      if (!p.userId && p.guestName) {
        players.push({ name: p.guestName, avatarUrl: null, isBooker: false, registered: false });
      }
    }

    const venueReview: MyVenueReview | null = review
      ? { id: review.id, bookingId: review.bookingId, rating: review.rating, status: review.status }
      : null;

    return {
      ...b,
      clubSlug: club?.slug ?? null,
      // A club that takes no money online is paid at the club, which is every
      // pilot club (#354). A club gone from under its booking is treated the
      // same: there is nothing online to point at.
      payAtClub: !club?.onlinePaymentEnabled,
      venueReview,
      canReview: canReview({ status: b.status, venueReview }),
      players,
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
 */
export function canReview(b: { status: string; venueReview: MyVenueReview | null }): boolean {
  return b.status === 'COMPLETED' && b.venueReview === null;
}
