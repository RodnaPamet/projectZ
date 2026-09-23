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

  // ═══ THE RANGE GUARD TOLERATES ONE DST HOUR ═══
  //
  // A local day is 23 or 25 hours. Measuring the request as a fixed number of
  // 86_400_000ms days means a legitimate 14-day window spanning the October
  // changeover measures 14 days and 1 hour, and gets rejected as a DoS attempt
  // — in late October only.
  const spanMs = to.getTime() - from.getTime();
  if (spanMs > MAX_RANGE_DAYS * 86_400_000 + 3_600_000) {
    throw new RangeTooWideError(Math.ceil(spanMs / 86_400_000));
  }

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
    const exceptions = windows.filter(
      (w) => w.exceptionDate && ymdFromDateColumn(w.exceptionDate) === dateKey,
    );

    const applicable =
      exceptions.length > 0
        ? exceptions
        : windows.filter((w) => {
            if (w.exceptionDate) return false;
            if (w.dayOfWeek !== dayOfWeek) return false;
            if (w.effectiveFrom && dayStartUtc < w.effectiveFrom) return false;
            if (w.effectiveTo && dayStartUtc > w.effectiveTo) return false;
            return true;
          });

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
