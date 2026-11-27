/**
 * HOW LONG EACH RECORD IS KEPT (#717): the privacy policy's section 13, as
 * numbers. content/legal/{bg,en}/privacy.md says these in words; the daily
 * retention sweep (src/app-layer/usecases/retention-sweep.ts) enforces them.
 * Change one here only together with the policy, in both languages.
 *
 * Plain data and pure functions, no imports: the unit tests pin the cut-off
 * arithmetic without a database.
 */
export const RETENTION = {
  /** Bookings, the club's payment entries and booking history: 5 years after the booking ends. */
  bookingYears: 5,
  /** The club's history of booking and staff changes (`audit_entry`): 5 years. */
  auditYears: 5,
  /** Moderation records (reports, cases and decisions): 5 years. */
  moderationYears: 5,
  /** Accepted texts of a deleted account: 5 years after the deletion. */
  acceptedTextsAfterDeletionYears: 5,
  /** "For clubs" enquiries and their email copy: 2 years after the last contact. */
  contactRequestYears: 2,
  /** The team's second-factor attempts (`account_security_event`): 1 year. */
  securityEventYears: 1,
  /**
   * Club credit movements: 5 years after a person's newest movement at a club,
   * and only once that balance is zero (owner 2026-11-27). A balance in use
   * keeps every movement.
   */
  creditYears: 5,
  /** Session records (IP address, User-Agent): 90 days after the session ends. */
  sessionDays: 90,
} as const;

/**
 * `now` minus whole calendar years, in UTC, the way Postgres computes
 * `now() - interval 'N years'`: 29 February lands on 28 February.
 *
 * It has to agree with Postgres, not just be close. The append-only triggers
 * on `audit_entry` and `account_security_event` (P92) refuse a delete of any
 * row younger than their own `now() - interval`, and one refused row aborts
 * the whole batch. JavaScript's `setUTCFullYear` would roll 29 February
 * forward to 1 March, a day LATER than the database's cut-off, and the sweep
 * would ask to delete a day the trigger still protects.
 */
export function yearsBefore(now: Date, years: number): Date {
  const d = new Date(now.getTime());
  const month = d.getUTCMonth();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  // The day overflowed into the next month (29 Feb in a common year): back to
  // the last day of the month it should be in.
  if (d.getUTCMonth() !== month) d.setUTCDate(0);
  return d;
}

/** `now` minus whole days of 24 hours. */
export function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

export interface RetentionCutoffs {
  /** A booking that ended before this is anonymised. */
  bookingsEndedBefore: Date;
  /** A club history row made before this goes (unless its booking is younger). */
  auditBefore: Date;
  /** A closed moderation case decided, or a report filed, before this goes. */
  moderationBefore: Date;
  /** Accepted texts of an account deleted before this go. */
  acceptedTextsDeletedBefore: Date;
  /** An enquiry whose last contact was before this goes. */
  contactBefore: Date;
  /** A second-factor event before this goes. */
  securityEventsBefore: Date;
  /** A session that ended (expired or was signed out) before this goes. */
  sessionsEndedBefore: Date;
  /** A zero credit balance whose newest movement is before this is anonymised. */
  creditLastMovementBefore: Date;
}

export function retentionCutoffs(now: Date): RetentionCutoffs {
  return {
    bookingsEndedBefore: yearsBefore(now, RETENTION.bookingYears),
    auditBefore: yearsBefore(now, RETENTION.auditYears),
    moderationBefore: yearsBefore(now, RETENTION.moderationYears),
    acceptedTextsDeletedBefore: yearsBefore(now, RETENTION.acceptedTextsAfterDeletionYears),
    contactBefore: yearsBefore(now, RETENTION.contactRequestYears),
    securityEventsBefore: yearsBefore(now, RETENTION.securityEventYears),
    sessionsEndedBefore: daysBefore(now, RETENTION.sessionDays),
    creditLastMovementBefore: yearsBefore(now, RETENTION.creditYears),
  };
}

/**
 * A moment as the wall-clock text of a `timestamp without time zone` column
 * written in UTC (Prisma's `DateTime` without `@db.Timestamptz`), for raw SQL
 * that casts it with `::timestamp`.
 */
export const utcWall = (d: Date): string => d.toISOString().slice(0, 23);

/** A moment's UTC calendar day, for a `@db.Date` column. */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
