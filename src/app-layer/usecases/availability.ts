import { fromZonedTime, toZonedTime } from 'date-fns-tz';

import { computePrice, type PriceContext, type PricingRuleRow } from './pricing';

/**
 * Slot materialisation.
 *
 * ─── The timezone trap ──────────────────────────────────────────────
 *
 * A court's opening hours are a WALL-CLOCK fact: "09:00 to 22:00, local
 * time". They are not an instant. Sofia is UTC+2 in winter and UTC+3 in
 * summer, so "09:00 local" is a different absolute moment depending on the
 * date — and on the two changeover days it is a different offset for
 * bookings a few hours apart.
 *
 * The naive implementation — `new Date(day + 'T09:00:00Z')`, or worse,
 * building dates in the SERVER's timezone — is correct on a laptop in
 * Sofia, correct in CI (UTC) for half the year, and then quietly shifts
 * every slot by an hour at the end of March. Players show up an hour late.
 *
 * So: opening hours are interpreted in the VENUE's timezone and converted
 * to absolute UTC per day. `fromZonedTime` does the offset lookup for that
 * specific date, which is the only way to get the changeover days right.
 */

export const MAX_RANGE_DAYS = 14;

export class RangeTooWideError extends Error {
  constructor(days: number) {
    super(
      `Requested ${days} days of availability; the maximum is ${MAX_RANGE_DAYS}. ` +
        `An unbounded range materialises unbounded slots and is a trivial DoS.`,
    );
    this.name = 'RangeTooWideError';
  }
}

/**
 * The widest window anyone may ask for, in milliseconds.
 *
 * ═══ THE RANGE GUARD TOLERATES ONE DST HOUR ═══
 *
 * A local day is 23 or 25 hours. Measuring the request as a fixed number of
 * 86_400_000ms days means a legitimate 14-day window spanning the October
 * changeover measures 14 days and 1 hour, and gets rejected as a DoS attempt
 * — in late October only.
 */
export const MAX_RANGE_MS = MAX_RANGE_DAYS * 86_400_000 + 3_600_000;

/**
 * One ceiling, checked in two places on purpose.
 *
 * `computeSlots` enforces it because it is the thing that materialises the
 * slots. The ROUTE enforces it too, before it queries — and that is not
 * belt-and-braces, it is the only one that bounds the database.
 *
 * The route used to leave this entirely to the use case, on the reasoning that
 * "it is the use case's ceiling, not this route's". But the route fetches the
 * bookings FIRST and computes slots second, so `?from=2016-01-01&to=2036-01-01`
 * ran a twenty-year query across every court in the venue before anything
 * looked at the width. A venue past the booking tripwire then answered 500
 * INTERNAL for a request that had earned a 400.
 *
 * Exported as one function so the two call sites cannot drift: a route that
 * bounds the range slightly differently from the use case is a route that
 * either rejects legitimate requests or fails to bound the query.
 */
export function assertRangeWithinLimit(from: Date, to: Date): void {
  const spanMs = to.getTime() - from.getTime();
  if (spanMs > MAX_RANGE_MS) {
    throw new RangeTooWideError(Math.ceil(spanMs / 86_400_000));
  }
}

export interface AvailabilityWindow {
  dayOfWeek: number;
  /** Venue-local clock, minutes from midnight. */
  openMinutes: number;
  closeMinutes: number;
  effectiveFrom?: Date | null;
  effectiveTo?: Date | null;
  /** A one-off override for a single date (holiday, maintenance). */
  exceptionDate?: Date | null;
}

export interface BookedRange {
  startTs: Date;
  endTs: Date;
}

export interface Slot {
  startTs: Date;
  endTs: Date;
  priceCents: number;
  available: boolean;
  blockedReason?: string;
}

export interface SlotOptions {
  from: Date;
  to: Date;
  timezone: string;
  slotStepMinutes: number;
  minBookingMinutes: number;
  basePriceCents: number;
  windows: readonly AvailabilityWindow[];
  booked: readonly BookedRange[];
  pricingRules?: readonly PricingRuleRow[];
  playerTags?: readonly string[];
  membershipLevel?: string | null;
}

/** Half-open overlap: [a,b) vs [c,d). Back-to-back does NOT overlap. */
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  // Mirrors the Postgres EXCLUDE constraint's '[)' range exactly. If this
  // disagreed with the database, the UI would offer a slot the INSERT then
  // rejects — the worst kind of bug: it looks like a race, and it isn't.
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Calendar date of a Date read through its LOCAL fields.
 *
 * `toISOString().slice(0,10)` is the obvious spelling and it is wrong here.
 * `toZonedTime` returns a Date whose LOCAL accessors carry the target zone's
 * wall clock, so re-serialising it through UTC shifts it back by the SERVER's
 * offset. Measured on this repo's own machine (Europe/Vienna) against a
 * 00:30 Sofia wall clock:
 *
 *     toISOString().slice(0,10)  → "2026-06-30"   ✗
 *     local fields               → "2026-07-01"   ✓
 *
 * It agrees with the correct answer on a UTC host, which is what CI is — so
 * the old spelling passed every test and would have mismatched exception rows
 * by a day on any server east of Greenwich.
 */
function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Calendar date of a DATE column.
 *
 * `exceptionDate` is `@db.Date` — a calendar date with no instant in it.
 * Prisma hands it back as midnight UTC, and running that through a timezone
 * conversion is a category error: for a venue at UTC-4, midnight UTC on the
 * 15th becomes 20:00 on the 14th, and the club's holiday closure silently
 * applies to the wrong day.
 *
 * A date column is read through its UTC fields, never converted.
 */
function ymdFromDateColumn(d: Date): string {
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

/**
 * Which opening rules govern one local day.
 *
 * Shared by `computeSlots` and `quoteBooking` deliberately. These two answer
 * the same question from opposite directions — "what can be booked?" and "may
 * THIS be booked?" — and if they ever disagreed, the app would show a slot the
 * booking endpoint then refuses, or worse, refuse a slot it had just offered.
 * One implementation is the only way that stays true.
 */
function applicableWindows(
  windows: readonly AvailabilityWindow[],
  day: { dateKey: string; dayOfWeek: number; dayStartUtc: Date },
): readonly AvailabilityWindow[] {
  // An exception row for this date REPLACES the recurring rule. A holiday
  // closure must not be additively merged with "we're open Mondays".
  const exceptions = windows.filter(
    (w) => w.exceptionDate && ymdFromDateColumn(w.exceptionDate) === day.dateKey,
  );

  if (exceptions.length > 0) return exceptions;

  return windows.filter((w) => {
    if (w.exceptionDate) return false;
    if (w.dayOfWeek !== day.dayOfWeek) return false;
    if (w.effectiveFrom && day.dayStartUtc < w.effectiveFrom) return false;
    if (w.effectiveTo && day.dayStartUtc > w.effectiveTo) return false;
    return true;
  });
}

export class SlotNotBookableError extends Error {
  readonly code = 'slot_not_bookable';
  constructor(reason: string) {
    super(`That time cannot be booked: ${reason}.`);
    this.name = 'SlotNotBookableError';
  }
}

export interface BookingQuote {
  priceCents: number;
  /** How many billable units of `minBookingMinutes` the span covers. */
  units: number;
}

export interface BookingQuoteOptions {
  startTs: Date;
  endTs: Date;
  timezone: string;
  windows: readonly AvailabilityWindow[];
  basePriceCents: number;
  minBookingMinutes: number;
  maxBookingMinutes: number;
  slotStepMinutes: number;
  pricingRules?: readonly PricingRuleRow[];
  playerTags?: readonly string[];
  membershipLevel?: string | null;
}

/**
 * What a span costs, and whether the club offers it at all.
 *
 * ═══ WHY THE SERVER PRICES, ALWAYS ═══
 *
 * `createBooking` takes `totalCents` from its caller and writes it down
 * without opinion — correctly, because it is a persistence concern. That
 * makes the ROUTE the last place a price can be decided, and a route that
 * forwards a client-supplied number lets anyone book a €24 court for one
 * cent. No constraint downstream catches it: the amount is perfectly valid,
 * it is just wrong.
 *
 * ═══ WHY IT COUNTS UNITS INSTEAD OF PRICING ONCE ═══
 *
 * `computePrice` answers for ONE slot and knows nothing about duration —
 * `basePriceCents` is the price of a single `minBookingMinutes` block, which
 * is exactly how `computeSlots` uses it. Calling it once for a three-hour
 * booking would therefore charge for one hour.
 *
 * So the span is decomposed into consecutive units and each is priced on its
 * own. That is not merely safer arithmetic: pricing rules are time-of-day
 * dependent, so a booking running from off-peak into peak picks up the peak
 * rate for the part that is actually peak. Pricing the whole span by its start
 * time would sell the evening at the afternoon rate.
 *
 * The cost is a real restriction, stated rather than hidden: a span must be a
 * whole number of `minBookingMinutes` units. A club wanting 90-minute
 * bookings sets a 30-minute minimum. Anything else would require deciding how
 * to price a fraction of a unit, and every answer to that is a guess about the
 * club's intent.
 */
export function quoteBooking(opts: BookingQuoteOptions): BookingQuote {
  const durationMs = opts.endTs.getTime() - opts.startTs.getTime();

  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new SlotNotBookableError('the end is not after the start');
  }
  if (durationMs % 60_000 !== 0) {
    throw new SlotNotBookableError('bookings are made in whole minutes');
  }

  // ═══ THE START MUST ALSO BE ON A WHOLE MINUTE ═══
  //
  // The duration check above does NOT imply this: 06:00:30 → 07:00:30 is
  // exactly one hour, so it passes, and both endpoints carry the same stray
  // half-second.
  //
  // It matters because the round-trip guard further down rebuilds the start
  // from `getHours() * 60 + getMinutes()`, which cannot represent seconds. A
  // sub-minute start therefore never round-trips, and the guard rejected it
  // with "that wall-clock time does not exist on that date" — on an ordinary
  // Wednesday in July, nowhere near a changeover. A client author reading that
  // message has no way to find the real cause.
  //
  // Epoch-ms modulo needs no timezone: every IANA offset in the bookable era
  // is a whole number of minutes (+05:30, +05:45 and +12:45 included), so
  // "whole minute in UTC" and "whole minute on the club's wall clock" are the
  // same predicate.
  //
  // Rejected rather than rounded. Truncating to 06:00 would write a booking
  // whose range is off the step grid that `computeSlots` and the
  // `booking_no_overlap` EXCLUDE constraint both work in, while the pricing
  // below would have charged it as 06:00 regardless.
  if (opts.startTs.getTime() % 60_000 !== 0) {
    throw new SlotNotBookableError('bookings start on a whole minute');
  }

  const durationMinutes = durationMs / 60_000;

  if (durationMinutes < opts.minBookingMinutes) {
    throw new SlotNotBookableError(`the minimum booking is ${opts.minBookingMinutes} minutes`);
  }
  if (durationMinutes > opts.maxBookingMinutes) {
    throw new SlotNotBookableError(`the maximum booking is ${opts.maxBookingMinutes} minutes`);
  }
  if (durationMinutes % opts.minBookingMinutes !== 0) {
    throw new SlotNotBookableError(`bookings are made in ${opts.minBookingMinutes}-minute units`);
  }

  const localStart = toZonedTime(opts.startTs, opts.timezone);
  const startMinutes = localStart.getHours() * 60 + localStart.getMinutes();
  const endMinutes = startMinutes + durationMinutes;

  // ═══ THE ROUND TRIP ═══
  //
  // `startMinutes` came from the instant the client sent. Rebuilding the
  // instant from those minutes must land back on it.
  //
  // It does not for an AMBIGUOUS wall clock — the hour that happens twice on
  // the autumn fall-back day. Measured on Sofia's 2026-10-25, where 03:30
  // local is both 00:30Z and 01:30Z: rebuilding resolves to 01:30Z, so a
  // booking sent as the FIRST 03:30 would be priced against one instant and
  // checked for clashes against another an hour away.
  //
  // The mirror case needs no guard: a wall clock skipped by a spring-forward
  // morning corresponds to no instant at all, so a client cannot express one.
  //
  // Rejecting costs one bookable hour a year, at 03:30. Accepting costs a
  // booking that silently is not when the player thinks it is.
  //
  // The message says AMBIGUOUS, which is what this actually catches. It used
  // to say "does not exist on that date" — a description of the spring-forward
  // case, which the paragraph above correctly explains is unreachable. So the
  // string contradicted the comment directly over it, and it was also the
  // message a sub-minute start got before the whole-minute guard above
  // existed. Two different wrong answers from one line.
  const rebuilt = localMinutesToUtc(localStart, startMinutes, opts.timezone);
  if (rebuilt.getTime() !== opts.startTs.getTime()) {
    throw new SlotNotBookableError('that wall-clock time is ambiguous on that date');
  }

  const dayStartUtc = localMinutesToUtc(localStart, 0, opts.timezone);
  const applicable = applicableWindows(opts.windows, {
    dateKey: ymd(localStart),
    dayOfWeek: localStart.getDay(),
    dayStartUtc,
  });

  // The whole span must sit inside ONE window. A booking that bridges the
  // lunchtime closure is two bookings with a gap, not one long one.
  const window = applicable.find(
    (w) => startMinutes >= w.openMinutes && endMinutes <= w.closeMinutes,
  );

  if (!window) {
    throw new SlotNotBookableError('the club is not open for that whole period');
  }

  // Offsets are measured from the window's opening, not from midnight: a club
  // opening at 09:15 with 30-minute steps offers 09:15 and 09:45, never 09:30.
  if ((startMinutes - window.openMinutes) % opts.slotStepMinutes !== 0) {
    throw new SlotNotBookableError(
      `bookings start every ${opts.slotStepMinutes} minutes from opening`,
    );
  }

  const units = durationMinutes / opts.minBookingMinutes;
  let priceCents = 0;

  for (let u = 0; u < units; u++) {
    const unitStart = startMinutes + u * opts.minBookingMinutes;
    const ctx: PriceContext = {
      basePriceCents: opts.basePriceCents,
      localDayOfWeek: localStart.getDay(),
      localStartMinutes: unitStart,
      localEndMinutes: unitStart + opts.minBookingMinutes,
      playerTags: opts.playerTags,
      membershipLevel: opts.membershipLevel,
    };
    priceCents += computePrice(opts.pricingRules ?? [], ctx).finalPriceCents;
  }

  return { priceCents, units };
}

export function computeSlots(opts: SlotOptions): Slot[] {
  const {
    from,
    to,
    timezone,
    slotStepMinutes,
    minBookingMinutes,
    basePriceCents,
    windows,
    booked,
  } = opts;

  assertRangeWithinLimit(from, to);

  const slots: Slot[] = [];

  // ═══ WALK LOCAL CALENDAR DAYS, NOT 24-HOUR BLOCKS ═══
  //
  // Stepping `from + d * 86_400_000` assumes every day is 24 hours. On the
  // October fall-back day it is 25, so the step lands back inside the SAME
  // local date and that date's windows are materialised twice. Measured, on
  // Sofia's 2026-10-25: six slots where the club offers three, every one of
  // them duplicated.
  //
  // March is not symmetric, despite looking like it should be: the 23-hour day
  // drifts each subsequent day-start an hour LATER rather than colliding, and
  // since the slot times are built from the calendar date rather than the
  // drifted instant, a daytime window still lands correctly. Checked, rather
  // than assumed — the fall-back duplication is the failure that bites, and
  // claiming a March one that does not reproduce would just be noise.
  //
  // So the loop counts in the venue's calendar, and `fromZonedTime` resolves
  // each local midnight to its own real offset.
  const firstLocal = toZonedTime(from, timezone);
  const y0 = firstLocal.getFullYear();
  const m0 = firstLocal.getMonth();
  const d0 = firstLocal.getDate();

  for (let d = 0; d <= MAX_RANGE_DAYS + 1; d++) {
    // Noon, not midnight: only the calendar fields are read off this, and a
    // zone that skips midnight on a spring-forward day would shift the date.
    const localDay = new Date(y0, m0, d0 + d, 12);
    const dayStartUtc = fromZonedTime(new Date(y0, m0, d0 + d, 0, 0, 0, 0), timezone);

    if (dayStartUtc >= to) break;

    const dayOfWeek = localDay.getDay();
    const dateKey = ymd(localDay);

    // An exception row for this date REPLACES the recurring rule. A holiday
    // closure must not be additively merged with "we're open Mondays".
    const applicable = applicableWindows(windows, { dateKey, dayOfWeek, dayStartUtc });

    for (const w of applicable) {
      for (let m = w.openMinutes; m + minBookingMinutes <= w.closeMinutes; m += slotStepMinutes) {
        const startTs = localMinutesToUtc(localDay, m, timezone);
        const endTs = localMinutesToUtc(localDay, m + minBookingMinutes, timezone);

        if (endTs <= from || startTs >= to) continue;

        const clash = booked.find((b) => overlaps(startTs, endTs, b.startTs, b.endTs));

        const priceCtx: PriceContext = {
          basePriceCents,
          localDayOfWeek: dayOfWeek,
          localStartMinutes: m,
          localEndMinutes: m + minBookingMinutes,
          playerTags: opts.playerTags,
          membershipLevel: opts.membershipLevel,
        };

        const { finalPriceCents } = computePrice(opts.pricingRules ?? [], priceCtx);

        slots.push({
          startTs,
          endTs,
          priceCents: finalPriceCents,
          available: !clash,
          ...(clash ? { blockedReason: 'booked' } : {}),
        });
      }
    }
  }

  return slots.sort((a, b) => a.startTs.getTime() - b.startTs.getTime());
}

/**
 * Venue-local wall-clock minutes on a given local day → absolute UTC.
 *
 * `fromZonedTime` resolves the offset FOR THAT DATE, which is the whole
 * point: on 2026-03-29 Sofia jumps from UTC+2 to UTC+3, and a slot at 09:00
 * before and after the switch are different absolute instants.
 */
function localMinutesToUtc(localDay: Date, minutes: number, timezone: string): Date {
  const y = localDay.getFullYear();
  const mo = localDay.getMonth();
  const d = localDay.getDate();
  const h = Math.floor(minutes / 60);
  const min = minutes % 60;

  // Construct the naive local wall-clock, then ask what instant that is IN
  // the venue's zone.
  const naive = new Date(y, mo, d, h, min, 0, 0);
  return fromZonedTime(naive, timezone);
}
