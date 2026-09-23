import { fromZonedTime } from 'date-fns-tz';

import { minutesFromTimeColumn } from '@/app-layer/repositories/availability';
import { computeSlots, type AvailabilityWindow } from '@/app-layer/usecases/availability';

/**
 * Slot materialisation must not depend on the SERVER's timezone.
 *
 * ═══ WHY THIS FILE PINS TZ INSTEAD OF JUST ASSERTING ═══
 *
 * Nothing in `jest.config.mjs` sets TZ, so these tests otherwise run under
 * whatever the host happens to be — UTC on a CI runner, Europe/Vienna on this
 * repo's own machine. The two date-column bugs below are INVISIBLE under UTC:
 * the arithmetic that goes wrong is a shift by the server's own offset, and
 * under UTC that shift is zero.
 *
 * So a suite that runs only on a UTC runner cannot catch them by asserting
 * harder. It has to run somewhere else. Node re-reads `process.env.TZ` on the
 * next Date operation, which makes that a one-line fixture rather than a CI
 * matrix.
 *
 * Europe/Vienna is chosen because it is east of Greenwich, which is the
 * direction that breaks `toISOString().slice(0,10)` on a midnight wall clock.
 */
const ORIGINAL_TZ = process.env.TZ;

beforeAll(() => {
  process.env.TZ = 'Europe/Vienna';
});

afterAll(() => {
  // Restore, or every later suite in this worker inherits Vienna.
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const SOFIA = 'Europe/Sofia';

const base = {
  timezone: SOFIA,
  slotStepMinutes: 60,
  minBookingMinutes: 60,
  basePriceCents: 1000,
  booked: [],
};

describe('server timezone independence', () => {
  it('materialises a normal day correctly from a host east of Greenwich', () => {
    // A guard, NOT a reproduction: the old code passes this one, because its
    // day key and its window matching were shifted by the same amount and the
    // error cancelled. It is here so that a future change which shifts only
    // ONE of the two has something to fail against — which is precisely how
    // the exception-row bug below escaped notice.
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
    // `exceptionDate` is `@db.Date` — a calendar date, no instant in it.
    // Prisma returns midnight UTC. Converting that to the venue's zone is a
    // category error, and on a UTC+n host it disagrees with the day key by a
    // day, so the holiday closure lands on the wrong date: the club is shut
    // and the app keeps selling the courts.
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
