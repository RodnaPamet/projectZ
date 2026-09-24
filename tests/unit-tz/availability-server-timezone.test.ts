import { fromZonedTime } from 'date-fns-tz';

import { minutesFromTimeColumn } from '@/app-layer/repositories/availability';
import {
  computeSlots,
  quoteBooking,
  type AvailabilityWindow,
} from '@/app-layer/usecases/availability';

/**
 * Slot materialisation must not depend on the SERVER's timezone.
 *
 * ═══ THE HOST IS PINNED BY THE RUNNER, NOT BY THIS FILE ═══
 *
 * This file used to open with:
 *
 *     const ORIGINAL_TZ = process.env.TZ;
 *     beforeAll(() => { process.env.TZ = 'Europe/Vienna'; });
 *
 * which does NOTHING. Node caches the zone on first use and jest's sandboxed
 * `process` never triggers a tzset. Measured: assigning Pacific/Honolulu
 * mid-test left `Intl.DateTimeFormat().resolvedOptions().timeZone` reporting
 * the host's own zone and `getHours()` unchanged.
 *
 * So the file ran under whatever the machine happened to be — Europe/Vienna
 * here, UTC on CI — while looking pinned. That appearance is the whole
 * problem: a reader has no reason to check.
 *
 * `npm run test:tz` now runs this suite TWICE with TZ set by the shell before
 * Node starts, once from each side of Greenwich. See jest.config.mjs.
 *
 * ═══ AND IT WAS PINNED TO THE WRONG SIDE ═══
 *
 * The old comment said Vienna was chosen "because it is east of Greenwich,
 * which is the direction that breaks it". That is backwards for the bug this
 * file is named after, and measurably so. Rewrite `ymdFromDateColumn` to use
 * local accessors — the exact regression the exception-row test exists to
 * catch — and:
 *
 *     Pacific/Honolulu (UTC-10) → FAILS      ← the bug is visible
 *     Pacific/Kiritimati (UTC+14) → passes
 *     Europe/Vienna → passes                 ← the zone it was "pinned" to
 *
 * Prisma returns a `@db.Date` as midnight UTC. East of Greenwich the local
 * calendar day of that instant is the same day, so local and UTC accessors
 * agree and nothing shows. WEST of Greenwich it is the day before.
 *
 * Both directions run because the other date bug — building a day key with
 * `toISOString()` instead of local fields — is the mirror image, visible only
 * from the east. Guessing a direction is what produced this file; running both
 * removes the guess.
 */

const SOFIA = 'Europe/Sofia';

const base = {
  timezone: SOFIA,
  slotStepMinutes: 60,
  minBookingMinutes: 60,
  basePriceCents: 1000,
  booked: [],
};

describe('server timezone independence', () => {
  it('materialises a normal day correctly, whatever the host zone', () => {
    // A smoke test, and honestly labelled as one. Its old comment claimed to
    // be a guard on `ymd` "so that a future change which shifts only ONE of
    // the two has something to fail against". It cannot be: `computeSlots`
    // calls `ymd` on NOON-local, where the local fields and
    // `toISOString().slice(0,10)` agree for every offset within ±12h. The
    // wrong spelling cannot differ here, in any zone — checked by mutation
    // under all four of Vienna, UTC, Honolulu and Kiritimati.
    //
    // The real `ymd` exposure is on the quoteBooking path, which works from a
    // genuine wall clock rather than from noon.
    const slots = computeSlots({
      ...base,
      // 2026-07-15 is a Wednesday.
      windows: [{ dayOfWeek: 3, openMinutes: 9 * 60, closeMinutes: 12 * 60 }],
      from: fromZonedTime(new Date(2026, 6, 15, 0, 0), SOFIA),
      to: fromZonedTime(new Date(2026, 6, 16, 0, 0), SOFIA),
    });

    expect(slots).toHaveLength(3);
    expect(slots[0]!.startTs.toISOString()).toBe('2026-07-15T06:00:00.000Z');
  });

  it('applies an exception row to the date the club actually typed', () => {
    // THE reproduction, and it only reproduces from the WEST.
    //
    // `exceptionDate` is `@db.Date` — a calendar date, no instant in it.
    // Prisma returns midnight UTC. Reading that through local accessors is a
    // category error: from a host west of Greenwich it resolves to the day
    // BEFORE, so the holiday closure lands on the wrong date — the club is
    // shut and the app keeps selling the courts.
    const windows: AvailabilityWindow[] = [
      { dayOfWeek: 3, openMinutes: 9 * 60, closeMinutes: 12 * 60 },
      {
        dayOfWeek: 3,
        openMinutes: 0,
        closeMinutes: 0,
        exceptionDate: new Date('2026-07-15T00:00:00Z'),
      },
    ];

    const slots = computeSlots({
      ...base,
      windows,
      from: fromZonedTime(new Date(2026, 6, 15, 0, 0), SOFIA),
      to: fromZonedTime(new Date(2026, 6, 16, 0, 0), SOFIA),
    });

    expect(slots).toHaveLength(0);
  });
});

describe('the day key on the quoting path', () => {
  it('resolves a MIDNIGHT wall clock to the local day, not the UTC one', () => {
    // The mirror of the exception-row test, and the reason both directions
    // run: this one only reproduces from the EAST.
    //
    // `quoteBooking` works from a real wall clock rather than from noon, so
    // `ymd` is genuinely exposed here. A booking at 00:30 Sofia on 1 July is
    // 21:30Z on 30 June. Spelling the day key `toISOString().slice(0,10)`
    // reads 2026-06-30, the exception row for 1 July does not match, the
    // recurring 09:00 window applies instead, and a legitimate booking is
    // refused as outside opening hours.
    //
    // 2026-07-01 is a Wednesday. The recurring window opens at 09:00; the
    // exception row opens the club 00:00-01:00 for that date only.
    const windows: AvailabilityWindow[] = [
      { dayOfWeek: 3, openMinutes: 9 * 60, closeMinutes: 17 * 60 },
      {
        dayOfWeek: 3,
        openMinutes: 0,
        closeMinutes: 60,
        exceptionDate: new Date('2026-07-01T00:00:00Z'),
      },
    ];

    const quote = quoteBooking({
      timezone: SOFIA,
      windows,
      basePriceCents: 1000,
      minBookingMinutes: 30,
      maxBookingMinutes: 120,
      slotStepMinutes: 30,
      // 00:30 Sofia on 2026-07-01.
      startTs: new Date('2026-06-30T21:30:00Z'),
      endTs: new Date('2026-06-30T22:00:00Z'),
    });

    expect(quote.priceCents).toBeGreaterThan(0);
  });
});

describe('reading a time column', () => {
  it('takes the wall clock from the UTC accessors', () => {
    // Postgres `time` has no date and no zone. Prisma returns it as a Date
    // pinned to 1970-01-01 UTC — measured: `SELECT '09:30:00'::time` comes
    // back as 1970-01-01T09:30:00.000Z.
    //
    // `getHours()` applies the SERVER's offset to that, so a club opening at
    // 09:30 is published as 10:30 from a UTC+1 host. The integration test
    // catches this too, but ONLY when the runner is not UTC — and CI is UTC,
    // so without this the regression would ship green.
    expect(minutesFromTimeColumn(new Date('1970-01-01T09:30:00Z'))).toBe(570);
    expect(minutesFromTimeColumn(new Date('1970-01-01T00:00:00Z'))).toBe(0);
    expect(minutesFromTimeColumn(new Date('1970-01-01T23:45:00Z'))).toBe(1425);
  });
});
