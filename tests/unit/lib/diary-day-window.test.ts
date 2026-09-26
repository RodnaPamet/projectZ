import { formatInTimeZone } from 'date-fns-tz';

import { dayWindow } from '@/app-layer/repositories/diary';

/**
 * "THURSDAY AT THIS CLUB" IS NOT 24 HOURS FROM MIDNIGHT UTC.
 *
 * A booking is `timestamptz`; a day is a wall-clock fact in the venue's zone.
 * Sofia is UTC+2 in winter and UTC+3 in summer, so the absolute window that
 * means one local day moves with the date — and on the two changeover days the
 * day is 23 or 25 hours long.
 *
 * These are unit tests, with no database, because the arithmetic is the part
 * that is wrong in the naive implementation and it is wrong silently: the
 * diary shows the wrong day's bookings, or misses the last hour of one.
 */

const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;

describe('dayWindow', () => {
  it('an ordinary winter day in Sofia is 24 hours, starting at 22:00 UTC the night before', () => {
    // Sofia is UTC+2 in January, so local midnight is 22:00 the previous day.
    const { from, to } = dayWindow('2026-01-15', 'Europe/Sofia');

    expect(from.toISOString()).toBe('2026-01-14T22:00:00.000Z');
    expect(to.toISOString()).toBe('2026-01-15T22:00:00.000Z');
    expect(hours(from, to)).toBe(24);
  });

  it('an ordinary summer day is 24 hours, starting at 21:00 UTC — a DIFFERENT offset', () => {
    // UTC+3 in July. A window built once and reused would be an hour out for
    // half the year, which is the naive bug.
    const { from, to } = dayWindow('2026-07-15', 'Europe/Sofia');

    expect(from.toISOString()).toBe('2026-07-14T21:00:00.000Z');
    expect(hours(from, to)).toBe(24);
  });

  it('SPRING FORWARD: the local day is 23 hours, not 24', () => {
    // EU DST starts on the last Sunday of March — 29 March 2026. Sofia jumps
    // 03:00 → 04:00, so that local day has 23 hours.
    //
    // `from + 24h` would reach an hour INTO the next day and show bookings
    // that belong on Monday's diary.
    const { from, to } = dayWindow('2026-03-29', 'Europe/Sofia');

    expect(hours(from, to)).toBe(23);
    expect(from.toISOString()).toBe('2026-03-28T22:00:00.000Z');
    expect(to.toISOString()).toBe('2026-03-29T21:00:00.000Z');
  });

  it('FALL BACK: the local day is 25 hours, not 24', () => {
    // Last Sunday of October — 25 October 2026. 04:00 → 03:00, so 25 hours.
    //
    // `from + 24h` would stop an hour EARLY and silently omit the last hour of
    // bookings — a court that reads free at 23:00 and is not.
    const { from, to } = dayWindow('2026-10-25', 'Europe/Sofia');

    expect(hours(from, to)).toBe(25);
    expect(from.toISOString()).toBe('2026-10-24T21:00:00.000Z');
    expect(to.toISOString()).toBe('2026-10-25T22:00:00.000Z');
  });

  it('crosses a month and a year boundary without arithmetic drift', () => {
    // The "next day" is built through Date.UTC rather than string surgery, so
    // month-ends and new year roll over rather than producing 2026-01-32.
    expect(dayWindow('2026-01-31', 'Europe/Sofia').to.toISOString()).toBe(
      '2026-01-31T22:00:00.000Z',
    );
    expect(dayWindow('2026-12-31', 'Europe/Sofia').to.toISOString()).toBe(
      '2026-12-31T22:00:00.000Z',
    );
    // And a leap day, which is the one every hand-rolled calendar gets wrong.
    expect(hours(...(Object.values(dayWindow('2028-02-29', 'Europe/Sofia')) as [Date, Date]))).toBe(
      24,
    );
  });

  it('is a property of the VENUE’s zone, not the server’s', () => {
    // A manager checking the diary from London must see the club's Thursday.
    // Same ISO day, two zones, two different absolute windows.
    const sofia = dayWindow('2026-07-15', 'Europe/Sofia');
    const london = dayWindow('2026-07-15', 'Europe/London');

    expect(sofia.from.toISOString()).not.toBe(london.from.toISOString());
    expect(hours(sofia.from, london.from)).toBe(2);
  });
});

/**
 * WHERE A BOOKING IS DRAWN, NOT JUST WHICH DAY IT BELONGS TO.
 *
 * `dayWindow` above was correct and its tests passed. The calendar page then
 * positioned each block with `(startTs - from) / 60000` — elapsed ABSOLUTE
 * time — which agrees with the wall clock on 363 days a year and diverges by
 * an hour on the other two, from the transition onward.
 *
 * So a booking whose own label read "15:00" was drawn against the 16:00 ruler:
 * the grid disagreeing with itself, which is exactly what the page's docblock
 * claimed could not happen. Correct window, wrong placement — the tests
 * covered the first and not the second.
 *
 * This is the arithmetic the page now uses, pinned directly.
 */
describe('wall-clock placement on a DST day', () => {
  const TZ = 'Europe/Sofia';

  /** The page's `wallMinutes`, in the same shape. */
  const wallMinutes = (d: Date, isoDay: string) => {
    const [hh, mm] = formatInTimeZone(d, TZ, 'HH:mm').split(':');
    const minutes = Number(hh) * 60 + Number(mm);
    const onDay = formatInTimeZone(d, TZ, 'yyyy-MM-dd');
    if (onDay < isoDay) return minutes - 1440;
    if (onDay > isoDay) return minutes + 1440;
    return minutes;
  };

  /** What the page did before: elapsed absolute minutes from the window start. */
  const elapsed = (d: Date, isoDay: string) =>
    Math.round((d.getTime() - dayWindow(isoDay, TZ).from.getTime()) / 60_000);

  it('FALL BACK: a 15:00 booking sits on the 15:00 row, not the 16:00 one', () => {
    // 25 October 2026, after the 04:00 -> 03:00 shift. 13:00Z is 15:00 local.
    const b = new Date('2026-10-25T13:00:00Z');

    expect(formatInTimeZone(b, TZ, 'HH:mm')).toBe('15:00');
    expect(wallMinutes(b, '2026-10-25')).toBe(15 * 60);
    // The bug, pinned so the fix cannot be quietly reverted.
    expect(elapsed(b, '2026-10-25')).toBe(16 * 60);
  });

  it('SPRING FORWARD: the same, an hour the other way', () => {
    // 29 March 2026, after 03:00 -> 04:00. 16:00Z is 19:00 local.
    const b = new Date('2026-03-29T16:00:00Z');

    expect(formatInTimeZone(b, TZ, 'HH:mm')).toBe('19:00');
    expect(wallMinutes(b, '2026-03-29')).toBe(19 * 60);
    expect(elapsed(b, '2026-03-29')).toBe(18 * 60);
  });

  it('an ordinary day is unaffected — the two agree', () => {
    const b = new Date('2026-01-15T17:00:00Z'); // 19:00 in Sofia, UTC+2
    expect(wallMinutes(b, '2026-01-15')).toBe(19 * 60);
    expect(elapsed(b, '2026-01-15')).toBe(19 * 60);
  });

  it('an overlapping booking from the night before gets a NEGATIVE offset', () => {
    // 23:00 local on the 14th, shown on the 15th's diary because it runs past
    // midnight. Reading its wall clock alone would put it at 1380 minutes —
    // the bottom of the wrong day.
    const b = new Date('2026-01-14T21:00:00Z');

    expect(formatInTimeZone(b, TZ, 'HH:mm')).toBe('23:00');
    expect(wallMinutes(b, '2026-01-15')).toBe(23 * 60 - 1440);
    expect(wallMinutes(b, '2026-01-15')).toBeLessThan(0);
  });

  it('a booking running past midnight is placed beyond the end of its own day', () => {
    // 00:30 local on the 16th, shown on the 15th's diary.
    const b = new Date('2026-01-15T22:30:00Z');

    expect(formatInTimeZone(b, TZ, 'HH:mm')).toBe('00:30');
    expect(wallMinutes(b, '2026-01-15')).toBe(30 + 1440);
  });
});
