/**
 * The player's cancellation cutoff (#354), as pure arithmetic.
 *
 * Kept free of Prisma and of the server so the DTO mapper and the admin form
 * can import it without dragging a database client into their bundles.
 */

/** The venue column's default, and the owner's. */
export const DEFAULT_CANCELLATION_CUTOFF_HOURS = 24;
/** The database CHECK's ceiling (`venue_cancellation_cutoff_range`): one week. */
export const MAX_CANCELLATION_CUTOFF_HOURS = 168;

const HOUR_MS = 3_600_000;

/**
 * The last instant a PLAYER may cancel in the app.
 *
 * ═══ ELAPSED HOURS, NOT WALL-CLOCK ═══
 *
 * "24 hours before" is measured on the absolute timeline: `startTs` is an
 * instant, and so is the result, so neither the server's zone nor UTC-vs-Sofia
 * enters into it. The one place a zone shows is the night a clock changes: a
 * 10:00 booking the morning after Sofia springs forward has a deadline of 09:00
 * the previous morning on the wall clock, not 10:00. Twice a year, for an hour;
 * the alternative ("same wall-clock time N days back") cannot express a cutoff
 * that is not a whole number of days. Clients show this instant in the venue's
 * timezone, so the player sees the real deadline either way.
 */
export function playerCancellableUntil(startTs: Date, cutoffHours: number): Date {
  return new Date(startTs.getTime() - cutoffHours * HOUR_MS);
}

/**
 * May a player cancel this booking themselves, now?
 *
 * Until the cutoff INCLUSIVE — someone who reads "until 24 h before" and taps at
 * exactly 24.0 h is inside it, as `computeRefundAmount` decided for its own
 * bands — and never at or after the start, which matters for a cutoff of 0.
 */
export function playerMayCancel(startTs: Date, cutoffHours: number, now: Date): boolean {
  return (
    now.getTime() <= playerCancellableUntil(startTs, cutoffHours).getTime() &&
    now.getTime() < startTs.getTime()
  );
}
