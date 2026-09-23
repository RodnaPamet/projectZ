import type { PrismaClient } from '@prisma/client';

import { InternalError } from '@/lib/errors/types';

/**
 * Everything needed to materialise slots, in a fixed number of queries.
 *
 * `computeSlots` is a pure function and has been since P?? — with unit tests
 * and, until now, no production caller. This is the layer that feeds it real
 * rows, which is where the interesting mistakes live: the ones that only show
 * up against a real database, in a real timezone, at a real DST boundary.
 */

/**
 * The statuses that occupy a slot.
 *
 * ═══ THIS LIST IS NOT A JUDGEMENT CALL ═══
 *
 * It mirrors `booking_no_overlap`'s WHERE clause, verbatim:
 *
 *     EXCLUDE USING gist ("resourceId" WITH =,
 *                         tstzrange("startTs","endTs",'[)') WITH &&)
 *     WHERE (status IN ('CONFIRMED', 'PENDING'))
 *
 * If this list is narrower than the constraint, availability offers a slot
 * whose INSERT the database then rejects. The player sees a green slot, taps
 * it, and gets an error — and it presents as an intermittent race, because the
 * slot really is free by the API's reckoning. If it is wider, slots vanish for
 * no reason anybody can explain.
 *
 * So: a CANCELLED booking frees its slot, and a PENDING one holds it.
 */
export const SLOT_HOLDING_STATUSES = ['PENDING', 'CONFIRMED'] as const;

/**
 * The most bookings this will materialise for one window before giving up.
 *
 * Not a page size — availability is not paginated, and a partial list is
 * actively dangerous (see the check at the end of getAvailabilityInputs).
 * It is a tripwire, set well above the reachable maximum.
 */
export const MAX_BOOKINGS_IN_WINDOW = 50_000;

/**
 * A `time` column arrives as a Date pinned to 1970-01-01 **UTC**.
 *
 * Measured, not assumed — `SELECT '09:30:00'::time` comes back as
 * `1970-01-01T09:30:00.000Z`. So the wall-clock the club typed is in the UTC
 * accessors, and ONLY in the UTC accessors:
 *
 *     getUTCHours()*60 + getUTCMinutes()  → 570  (09:30) ✓
 *     getHours()*60    + getMinutes()     → 630  (10:30) ✗ on a UTC+1 host
 *
 * The local-accessor version is not subtly wrong, it is wrong by the server's
 * offset — every slot at a club shifted by an hour. And it is RIGHT on a UTC
 * box, which is what CI usually is, so the test suite agrees with it right up
 * until it runs somewhere else.
 *
 * This is a different bug from the one `computeSlots` documents. That one is
 * about interpreting a wall-clock IN THE VENUE'S ZONE. This one is about
 * reading the wall-clock off the column at all, and it happens first.
 */
export function minutesFromTimeColumn(t: Date): number {
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

export interface PublicVenue {
  id: string;
  name: string;
  timezone: string;
}

/**
 * The venue, on its own, before anything else.
 *
 * Loaded first because the request's date range cannot be resolved without the
 * timezone: `?date=2026-09-24` means that calendar date AT THE CLUB, and until
 * this row is read there is no way to know which instants that is. Splitting it
 * out is what keeps `getAvailabilityInputs` from having to parse query strings.
 */
export async function getPublicVenue(
  db: PrismaClient,
  venueId: string,
): Promise<PublicVenue | null> {
  // guardrail-allow: cross-tenant — public availability, reached from the
  // public venue detail. `status: ACTIVE` is the only filter, exactly as in
  // getVenueById.
  return db.venue.findFirst({
    where: { id: venueId, status: 'ACTIVE' },
    select: { id: true, name: true, timezone: true },
  });
}

export interface AvailabilityInputs {
  resources: Array<{
    id: string;
    name: string;
    sport: string;
    basePriceCents: number;
    currency: string;
    minBookingMinutes: number;
    slotStepMinutes: number;
    availability: Array<{
      dayOfWeek: number;
      openTime: Date;
      closeTime: Date;
      effectiveFrom: Date | null;
      effectiveTo: Date | null;
      exceptionDate: Date | null;
    }>;
    pricingRules: Array<{
      id: string;
      name: string;
      priority: number;
      conditionsJson: unknown;
      multiplier: unknown;
      fixedPriceCents: number | null;
    }>;
  }>;
  bookings: Array<{ resourceId: string; startTs: Date; endTs: Date }>;
}

/**
 * Two queries, never N+1.
 *
 * Bookings are fetched for every resource at once rather than per resource:
 * a venue with twelve courts would otherwise issue twelve round trips to
 * render one screen, and that screen is the first thing the app opens.
 */
export async function getAvailabilityInputs(
  db: PrismaClient,
  opts: { venue: PublicVenue; resourceId?: string | null; from: Date; to: Date },
): Promise<AvailabilityInputs> {
  // guardrail-allow: cross-tenant — public availability. The venue was already
  // resolved by getPublicVenue, and venueId is unique across tenants, so
  // scoping to it IS the tenant scope.
  const resources = await db.resource.findMany({
    where: {
      venueId: opts.venue.id,
      status: 'ACTIVE',
      ...(opts.resourceId ? { id: opts.resourceId } : {}),
    },
    orderBy: { name: 'asc' },
    // Same ceiling as getVenueById's resource include. A public read takes a
    // bound from the repository, because defineV1Route cannot rate-limit a GET
    // — resolveRateLimitScope returns null for non-mutating methods before it
    // ever reads the options.
    take: 50,
    select: {
      id: true,
      name: true,
      sport: true,
      basePriceCents: true,
      currency: true,
      minBookingMinutes: true,
      slotStepMinutes: true,
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

  if (resources.length === 0) {
    return { resources: [], bookings: [] };
  }

  // guardrail-allow: cross-tenant — public availability, restricted to the
  // resource ids of the one venue resolved above. Three columns are selected
  // and none of them identifies the booker.
  const bookings = await db.booking.findMany({
    take: MAX_BOOKINGS_IN_WINDOW + 1,
    where: {
      resourceId: { in: resources.map((r) => r.id) },
      status: { in: [...SLOT_HOLDING_STATUSES] },
      // Half-open overlap with the requested window, matching the '[)' range
      // in the exclusion constraint: a booking ending exactly at `from` does
      // not overlap it, and neither does one starting exactly at `to`.
      startTs: { lt: opts.to },
      endTs: { gt: opts.from },
    },
    select: { resourceId: true, startTs: true, endTs: true },
  });

  // ═══ TRUNCATION HERE WOULD SELL A COURT TWICE ═══
  //
  // A `take` that silently cuts the list off does not lose a booking — it
  // makes an occupied slot look FREE, because a slot is available exactly
  // when no fetched booking overlaps it. The player books, and the exclusion
  // constraint rejects the INSERT at the last step of checkout.
  //
  // So the query asks for one more than the ceiling and refuses to answer at
  // all if it comes back. The ceiling is far above anything reachable — 50
  // resources over 14 days, booked solid every half hour, is under 34,000 —
  // so hitting it means something is wrong that guessing cannot fix.
  if (bookings.length > MAX_BOOKINGS_IN_WINDOW) {
    throw new InternalError(
      `Availability window for venue ${opts.venue.id} contains more than ` +
        `${MAX_BOOKINGS_IN_WINDOW} bookings; refusing to report availability ` +
        `from a truncated list.`,
    );
  }

  return { resources, bookings };
}
