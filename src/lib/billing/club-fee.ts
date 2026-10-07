import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/**
 * The club fee's arithmetic (#372): pure, so every rule here is tested without
 * a database and the same function writes the ledger and checks it.
 *
 * ═══ THE OWNER'S RULES (Q31, Q33–Q36) ═══
 *
 *   - a percentage of the COURT PRICE (the server quote stored on the booking),
 *     set per club;
 *   - only ONLINE bookings that end COMPLETED; desk bookings, cancellations
 *     and no-shows carry no fee;
 *   - a free period per club, by default two months from the club's start:
 *     its bookings are still listed, at 0;
 *   - one statement per club per calendar month AT THE CLUB.
 *
 * ═══ ROUNDING: HALF-UP, PER LINE, IN INTEGER CENTS ═══
 *
 * The rate is held in basis points (12.5% = 1250), so the fee on a line is one
 * integer product and one division: `floor((price × bps + 5000) / 10000)`. That
 * is half-up to the cent (2 400 × 1 250 = 3 000 000 → 300 c exactly; 1 × 5 000
 * = 5 000 → 1 c; 1 × 4 999 → 0 c), with no float anywhere near money. Each line
 * is rounded once, when it is written, and a statement's total is the SUM of
 * its lines' rounded fees, never a percentage of the summed prices. That is the
 * only total that matches the line items on the page and in the CSV to the
 * cent; the alternative "drifts" by up to half a cent per line against them.
 */

/** Every statement is told in the clubs' clock. All pilot clubs are in Sofia. */
export const FEE_TIME_ZONE = 'Europe/Sofia';

/** How long a club's free period lasts unless its terms say otherwise (Q35). */
export const DEFAULT_FREE_MONTHS = 2;

/** The largest fee a club can be set to, in percent (the CHECK in P48). */
export const MAX_FEE_PERCENT = 30;

/** `YYYY-MM`. */
export const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `YYYY-MM-DD`. */
export const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The calendar month an instant falls in at the club. */
export function statementMonthOf(instant: Date): string {
  return formatInTimeZone(instant, FEE_TIME_ZONE, 'yyyy-MM');
}

/** The calendar date an instant falls on at the club. */
export function clubDateOf(instant: Date): string {
  return formatInTimeZone(instant, FEE_TIME_ZONE, 'yyyy-MM-dd');
}

/** Whether `month` is a real `YYYY-MM`. */
export function isMonth(month: string): boolean {
  return MONTH_PATTERN.test(month);
}

/** Whether `date` is a real calendar date as `YYYY-MM-DD` (no 31 February). */
export function isCalendarDate(date: string): boolean {
  if (!DATE_PATTERN.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** `month` moved by `delta` months: `shiftMonth('2026-01', -1)` is `2025-12`. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The first and last calendar day of `month`, as `YYYY-MM-DD`. */
export function monthDays(month: string): { first: string; last: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(last).padStart(2, '0')}` };
}

/**
 * The instants `month` spans at the club: `[start, end)`.
 *
 * Resolved per boundary, so each side gets its own offset: October 2026 starts
 * at 2026-09-30T21:00Z (summer time, +03:00) and ends at 2026-10-31T22:00Z
 * (winter time, +02:00, after the 25 October change). Not used to SELECT a
 * statement, which is one equality on `statementMonth`; it is what the API
 * reports, so a client can say which hours a month covered.
 */
export function monthBounds(month: string): { start: Date; end: Date } {
  return {
    start: fromZonedTime(`${month}-01T00:00:00`, FEE_TIME_ZONE),
    end: fromZonedTime(`${shiftMonth(month, 1)}-01T00:00:00`, FEE_TIME_ZONE),
  };
}

/** `date` (YYYY-MM-DD) plus `months` calendar months, clamped to the month's end (31 Dec + 2 = 28/29 Feb). */
export function addMonthsToDate(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = shiftMonth(`${y}-${String(m).padStart(2, '0')}`, months);
  const { last } = monthDays(target);
  const lastDay = Number(last.slice(-2));
  return `${target}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/** A club's free period ends when it does not say: its creation date at the club + 2 months. */
export function defaultFeeStartsOn(clubCreatedAt: Date): string {
  return addMonthsToDate(clubDateOf(clubCreatedAt), DEFAULT_FREE_MONTHS);
}

/** The date the fee starts, from the stored column (a UTC-midnight Date) or the default. */
export function effectiveFeeStartsOn(stored: Date | null, clubCreatedAt: Date): string {
  return stored ? stored.toISOString().slice(0, 10) : defaultFeeStartsOn(clubCreatedAt);
}

/** Whether a booking starting at `startTs` is played inside the free period. */
export function isInFreePeriod(startTs: Date, feeStartsOn: string): boolean {
  return clubDateOf(startTs) < feeStartsOn;
}

/**
 * A percentage with at most two decimals (`"12.5"`, `12.25`, a Prisma Decimal's
 * string) as basis points, or null when it is not one or is out of range.
 *
 * Parsed from the decimal STRING, never multiplied as a float: `0.29 * 100` is
 * `28.999999999999996`, and truncating that would charge 28 bps for 29.
 */
export function percentToBps(value: string | number): number | null {
  const s = typeof value === 'number' ? String(value) : value.trim();
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bps <= MAX_FEE_PERCENT * 100 ? bps : null;
}

/** Basis points as the percentage string a person reads and the API returns: 1250 → "12.50". */
export function bpsToPercent(bps: number): string {
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}`;
}

/**
 * The fee on one line: `priceCents × bps / 10 000`, rounded half-up to the cent.
 * Integer arithmetic only. Prices here are never negative (a REVERSAL negates
 * a charge that was already rounded; it is never recomputed).
 */
export function feeCentsFor(priceCents: number, bps: number): number {
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
    throw new RangeError(`priceCents must be a non-negative integer, got ${priceCents}`);
  }
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_FEE_PERCENT * 100) {
    throw new RangeError(`bps must be an integer in 0..${MAX_FEE_PERCENT * 100}, got ${bps}`);
  }
  return Math.floor((priceCents * bps + 5_000) / 10_000);
}

/** What one booking's CHARGE line comes to. */
export function chargeFor(input: { priceCents: number; bps: number; free: boolean }): {
  feeBps: number;
  freePeriod: boolean;
  feeCents: number;
} {
  return {
    feeBps: input.bps,
    freePeriod: input.free,
    feeCents: input.free ? 0 : feeCentsFor(input.priceCents, input.bps),
  };
}

/** How much of `month` the free period covers. */
export type FreePeriodCover = 'all' | 'part' | 'none';

export function freePeriodCover(month: string, feeStartsOn: string): FreePeriodCover {
  const { first, last } = monthDays(month);
  if (feeStartsOn > last) return 'all';
  if (feeStartsOn <= first) return 'none';
  return 'part';
}

/**
 * The months a picker offers: `to` back to `from`, newest first, at most
 * `cap` of them. A `from` after `to` (a clock skew, a club created "next
 * month") still yields `to`, so a picker is never empty.
 */
export function monthsBack(from: string, to: string, cap = 24): string[] {
  const out: string[] = [to];
  let m = to;
  while (out.length < cap) {
    m = shiftMonth(m, -1);
    if (m < from) break;
    out.push(m);
  }
  return out;
}
