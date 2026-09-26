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
