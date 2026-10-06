/**
 * The club's cap on a player's upcoming ONLINE bookings (#380), as constants.
 *
 * Kept free of Prisma and of the server, like `cutoff.ts`, so the admin form
 * can import the range without dragging a database client into its bundle.
 */

/** The `VenueOrg.maxUpcomingOnlineBookings` default, and the owner's. */
export const DEFAULT_MAX_UPCOMING_ONLINE_BOOKINGS = 3;

/**
 * The database CHECK's range (`venue_org_max_upcoming_online_bookings_range`).
 *
 * At least 1: zero would mean "no online booking at all", which is a different
 * decision from a cap. At most 50: beyond that the number limits nobody, so a
 * club that wants no practical cap sets 50.
 */
export const MIN_MAX_UPCOMING_ONLINE_BOOKINGS = 1;
export const MAX_MAX_UPCOMING_ONLINE_BOOKINGS = 50;

export function isValidOnlineBookingCap(n: unknown): n is number {
  return (
    typeof n === 'number' &&
    Number.isInteger(n) &&
    n >= MIN_MAX_UPCOMING_ONLINE_BOOKINGS &&
    n <= MAX_MAX_UPCOMING_ONLINE_BOOKINGS
  );
}
