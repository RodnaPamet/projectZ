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
      venue: { select: { id: true, name: true, timezone: true } },
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
export async function listBookingsForUserAcrossClubs(
  db: PrismaClient,
  input: { userId: string; cursor?: string | null; limit?: number },
): Promise<{
  items: Array<Awaited<ReturnType<typeof getOwnBooking>> & { tenantId: string }>;
  nextCursor: string | null;
}> {
  const take = clampBookingLimit(input.limit);

  // guardrail-allow: cross-tenant — a person's own bookings span every club,
  // and the filter is their session-derived id, not a request parameter.
  const rows = await db.booking.findMany({
    where: { bookedByUserId: input.userId },
    select: { ...BOOKING_FIELDS, tenantId: true },
    orderBy: [{ startTs: 'desc' }, { id: 'desc' }],
    take: take + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;

  return {
    items: items as Array<Awaited<ReturnType<typeof getOwnBooking>> & { tenantId: string }>,
    nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
  };
}
