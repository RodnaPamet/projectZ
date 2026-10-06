import type { PrismaClient } from '@prisma/client';

/**
 * Reads that surround a booking write.
 *
 * Everything here runs INSIDE the tenant binding, so RLS is already filtering.
 * The explicit `tenantId` in each `where` is redundant under that policy and
 * deliberately kept: it is what makes these queries still correct if one is
 * ever run from a superuser path, and the structural guardrail checks for it
 * precisely so that "RLS will catch it" never becomes the only line of defence.
 */

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export function clampBookingLimit(requested?: number): number {
  if (!requested || requested < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(requested, MAX_PAGE_SIZE);
}

/**
 * The resource, with everything needed to QUOTE a span.
 *
 * Opening hours and pricing rules come back with it in one round trip,
 * because the route needs all three to answer and a booking is on the
 * latency-sensitive path — it is the tap the player waits on.
 */
export async function getResourceForBooking(
  db: PrismaClient,
  tenantId: string,
  resourceId: string,
) {
  return db.resource.findFirst({
    where: { id: resourceId, tenantId, status: 'ACTIVE' },
    select: {
      id: true,
      name: true,
      sport: true,
      basePriceCents: true,
      currency: true,
      minBookingMinutes: true,
      maxBookingMinutes: true,
      slotStepMinutes: true,
      venue: { select: { id: true, name: true, timezone: true, status: true } },
      availability: {
        select: {
          dayOfWeek: true,
          openTime: true,
          closeTime: true,
          effectiveFrom: true,
          effectiveTo: true,
          exceptionDate: true,
        },
      },
      pricingRules: {
        orderBy: { priority: 'desc' },
        select: {
          id: true,
          name: true,
          priority: true,
          conditionsJson: true,
          multiplier: true,
          fixedPriceCents: true,
        },
      },
    },
  });
}

const BOOKING_FIELDS = {
  id: true,
  resourceId: true,
  startTs: true,
  endTs: true,
  status: true,
  totalCents: true,
  currency: true,
  expiresAt: true,
  cancelledAt: true,
  createdAt: true,
  resource: {
    select: {
      id: true,
      name: true,
      sport: true,
      // The cutoff rides along so every booking a player is shown can say
      // until when they may cancel it (`cancellableUntil`, #354).
      venue: { select: { id: true, name: true, timezone: true, cancellationCutoffHours: true } },
    },
  },
} as const;

/**
 * One booking, but only if it is the caller's.
 *
 * `bookedByUserId` is in the WHERE rather than checked after the read. The
 * difference matters: a check afterwards means the row was already fetched,
 * and the natural next step when somebody refactors is to return it.
 */
export async function getOwnBooking(
  db: PrismaClient,
  tenantId: string,
  input: { bookingId: string; userId: string },
) {
  return db.booking.findFirst({
    where: { id: input.bookingId, tenantId, bookedByUserId: input.userId },
    select: BOOKING_FIELDS,
  });
}

/**
 * One booking by id, for staff who hold `bookings.view_all`.
 *
 * Kept separate from `getOwnBooking` rather than folded into it behind a
 * boolean. A single function with an `includeOthers` flag is one careless
 * `true` away from letting any player read any booking, and the call sites
 * would look identical in review.
 */
export async function getBookingById(db: PrismaClient, tenantId: string, bookingId: string) {
  return db.booking.findFirst({
    where: { id: bookingId, tenantId },
    select: BOOKING_FIELDS,
  });
}

/**
 * The caller's own bookings, newest first.
 *
 * Keyset pagination on `id`, not an offset. An offset re-reads and re-skips
 * every earlier row on each page, and it SKIPS or REPEATS rows when something
 * is inserted mid-scroll — which for a booking list is guaranteed, because the
 * player creating bookings is the one scrolling it.
 */
export async function listOwnBookings(
  db: PrismaClient,
  tenantId: string,
  input: { userId: string; cursor?: string | null; limit?: number },
): Promise<{ items: Array<Awaited<ReturnType<typeof getOwnBooking>>>; nextCursor: string | null }> {
  const take = clampBookingLimit(input.limit);

  const rows = await db.booking.findMany({
    where: { tenantId, bookedByUserId: input.userId },
    select: BOOKING_FIELDS,
    orderBy: [{ startTs: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  // One extra row is fetched purely to answer "is there another page?" without
  // a second COUNT query. It is dropped before returning.
  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;

  return {
    items,
    nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
  };
}

/** Which of a person's bookings a list shows (#359): still to be played, or not. */
export type BookingWhen = 'upcoming' | 'past';

/**
 * UPCOMING is a booking that still holds its court: PENDING or CONFIRMED, and
 * not over yet. A game in progress stays upcoming until its end, so a player
 * checking the court number mid-match still finds it on top. PAST is
 * everything else (ended, cancelled, completed, no-show), so a booking
 * cancelled for next week moves to Минали at once, labelled Отменена, and the
 * upcoming list only shows games that will happen.
 *
 * One definition for both tabs: `past` is `NOT upcoming`, so no booking can be
 * in both lists, or in neither.
 */
function upcomingWhere(now: Date) {
  return {
    status: { in: ['PENDING' as const, 'CONFIRMED' as const] },
    endTs: { gt: now },
  };
}

/**
 * Every booking this person holds, at EVERY club.
 *
 * ═══ WHY THIS IS CROSS-TENANT, AND WHY THAT IS SAFE ═══
 *
 * "My bookings" spans clubs by definition. A player books a padel court at one
 * club and a tennis court at another, and a list that showed only one of them
 * would be wrong in a way they could not see — the missing booking looks like
 * a booking that failed.
 *
 * The scope is `bookedByUserId`, which comes from a VERIFIED SESSION and never
 * from the request. So this cannot be pointed at anybody else: there is no
 * parameter to tamper with. It is the same argument the schema makes for
 * notifications and push subscriptions — "yours at every club you belong to,
 * not yours-at-this-club" — with the difference that `booking` carries a
 * tenant-scoped RLS policy and those tables do not, which is why the caller has
 * to bind superuser rather than `asUser`.
 *
 * The alternative was one bound query per membership. Rejected twice over: it
 * is N transactions for one page, and it would be driven by the token's
 * membership list, which is TRUNCATED at a cap — so a player with many clubs
 * would silently lose the tail of their own bookings.
 *
 * `bookedByUserId` is indexed (`@@index([bookedByUserId])`), so this does not
 * become a cross-tenant sequential scan as the table grows.
 */
/** A booking in a person's cross-club list: the booker tells the caller which side they are on. */
export type BookingAcrossClubs = NonNullable<Awaited<ReturnType<typeof getOwnBooking>>> & {
  tenantId: string;
  bookedByUserId: string | null;
};

/**
 * A person's bookings are the ones they BOOKED and, since #358, the ones they
 * were ADDED to (a `booking_participant` row with their id): an added player
 * sees the game in Резервации like the booker does. Both filters are the
 * session-derived id; `booking_participant.userId` is indexed like
 * `bookedByUserId`.
 */
function mine(userId: string) {
  return { OR: [{ bookedByUserId: userId }, { participants: { some: { userId } } }] };
}

export async function listBookingsForUserAcrossClubs(
  db: PrismaClient,
  input: {
    userId: string;
    cursor?: string | null;
    limit?: number;
    /** Omitted: every booking, newest first, as before #359. */
    when?: BookingWhen;
    /** The instant that splits upcoming from past. Defaults to the clock. */
    now?: Date;
  },
): Promise<{
  items: Array<BookingAcrossClubs>;
  nextCursor: string | null;
}> {
  const take = clampBookingLimit(input.limit);
  const now = input.now ?? new Date();

  // guardrail-allow: cross-tenant — a person's own bookings span every club,
  // and the filter is their session-derived id, not a request parameter.
  const rows = await db.booking.findMany({
    where: {
      ...mine(input.userId),
      ...(input.when === 'upcoming' ? upcomingWhere(now) : {}),
      ...(input.when === 'past' ? { NOT: upcomingWhere(now) } : {}),
    },
    select: { ...BOOKING_FIELDS, tenantId: true, bookedByUserId: true },
    // Upcoming reads soonest first, so the next game is on top (audit P05).
    // Everything else reads newest first.
    orderBy:
      input.when === 'upcoming'
        ? [{ startTs: 'asc' }, { id: 'asc' }]
        : [{ startTs: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;

  return {
    items: items as BookingAcrossClubs[],
    nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
  };
}

/**
 * ONE of this person's bookings, at any club, with what its detail page shows
 * (#359): the venue's address and coordinates for directions, its public slug
 * for a link back, and the people on the booking.
 *
 * Cross-tenant for `listBookingsForUserAcrossClubs`'s reason, and scoped the
 * same way: `mine(userId)` is in the WHERE (booked it, or was added to it,
 * #358), from a verified session. Another player's booking id finds nothing,
 * which the route answers 404, the same answer as an id that never existed,
 * so ids cannot be probed.
 *
 * Participants are ids and guest names only. Their emails are not selected at
 * all, rather than selected here and dropped by the mapper.
 */
export async function getBookingForUserAcrossClubs(
  db: PrismaClient,
  input: { userId: string; bookingId: string },
) {
  // guardrail-allow: cross-tenant — a person's own booking, at whichever club
  // it is; the filter is their session-derived id, not a request parameter.
  return db.booking.findFirst({
    where: {
      id: input.bookingId,
      ...mine(input.userId),
    },
    select: {
      ...BOOKING_FIELDS,
      tenantId: true,
      bookedByUserId: true,
      resource: {
        select: {
          ...BOOKING_FIELDS.resource.select,
          capacity: true,
          venue: {
            select: {
              ...BOOKING_FIELDS.resource.select.venue.select,
              publicSlug: true,
              addressLine: true,
              city: true,
              lat: true,
              lng: true,
              phone: true,
            },
          },
        },
      },
      participants: {
        select: { id: true, userId: true, guestName: true, position: true },
        orderBy: { position: 'asc' },
      },
    },
  });
}

/**
 * A person on a booking, as the booking shows them (#359, #358): a name and a
 * face. Never an email, a phone or a user id, for anybody: a participant sees
 * the other players' names and avatars and nothing they could contact them by.
 */
export interface BookingPlayer {
  /**
   * The `booking_participant` row, which is what the booker removes by. Null
   * for the booker, who is not a row (position 1 is `bookedByUserId`).
   */
  participantId: string | null;
  /** Null for a registered player who has not set a name yet. */
  name: string | null;
  avatarUrl: string | null;
  isBooker: boolean;
  /** The caller. */
  isYou: boolean;
  /** Registered (has an account), as opposed to a guest named by the booker. */
  registered: boolean;
}

/**
 * The booker first, then each participant by position: names and avatars
 * from `app_user`, which is global (no RLS), so this reads the same under a
 * tenant binding or the superuser one. One query for the whole booking.
 */
export async function readBookingPlayers(
  db: PrismaClient,
  b: {
    bookedByUserId: string | null;
    participants: ReadonlyArray<{
      id: string;
      userId: string | null;
      guestName: string | null;
      position: number;
    }>;
  },
  viewerId: string,
): Promise<BookingPlayer[]> {
  const rows = [...b.participants].sort((x, y) => x.position - y.position);
  const ids = [
    ...(b.bookedByUserId ? [b.bookedByUserId] : []),
    ...rows.flatMap((p) => (p.userId ? [p.userId] : [])),
  ];
  const unique = [...new Set(ids)];

  const users = unique.length
    ? await db.user.findMany({
        where: { id: { in: unique } },
        select: { id: true, name: true, avatarUrl: true },
        take: unique.length,
      })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));

  const players: BookingPlayer[] = [];
  if (b.bookedByUserId) {
    const u = byId.get(b.bookedByUserId);
    players.push({
      participantId: null,
      name: u?.name ?? null,
      avatarUrl: u?.avatarUrl ?? null,
      isBooker: true,
      isYou: b.bookedByUserId === viewerId,
      registered: true,
    });
  }
  for (const p of rows) {
    if (p.userId) {
      if (p.userId === b.bookedByUserId) continue;
      const u = byId.get(p.userId);
      players.push({
        participantId: p.id,
        name: u?.name ?? null,
        avatarUrl: u?.avatarUrl ?? null,
        isBooker: false,
        isYou: p.userId === viewerId,
        registered: true,
      });
    } else if (p.guestName) {
      players.push({
        participantId: p.id,
        name: p.guestName,
        avatarUrl: null,
        isBooker: false,
        isYou: false,
        registered: false,
      });
    }
  }
  return players;
}
