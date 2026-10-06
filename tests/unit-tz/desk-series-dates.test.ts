import { InvalidSeriesError, resolveSpan, shiftIsoDay, weeklyDates } from '@/lib/booking/weekly';

/**
 * A weekly desk series (#364) is a wall-clock rule at the CLUB: "Tuesdays at
 * 19:00 in Sofia". `npm run test:tz` runs this from Honolulu and Kiritimati,
 * so nothing here may lean on the host's zone.
 */
const SOFIA = 'Europe/Sofia';

describe('weeklyDates', () => {
  it('one date with no repeat; n dates a week apart for `weeks`', () => {
    expect(weeklyDates('2026-10-20', undefined)).toEqual(['2026-10-20']);
    expect(weeklyDates('2026-10-20', { weeks: 3 })).toEqual([
      '2026-10-20',
      '2026-10-27',
      '2026-11-03',
    ]);
  });

  it('`until` is inclusive, and crosses month and year ends', () => {
    expect(weeklyDates('2026-12-22', { until: '2027-01-05' })).toEqual([
      '2026-12-22',
      '2026-12-29',
      '2027-01-05',
    ]);
    expect(weeklyDates('2026-12-22', { until: '2027-01-04' })).toEqual([
      '2026-12-22',
      '2026-12-29',
    ]);
  });

  it('refuses a series that runs backwards or past a year, rather than truncating it', () => {
    expect(() => weeklyDates('2026-10-20', { until: '2026-10-19' })).toThrow(InvalidSeriesError);
    expect(() => weeklyDates('2026-01-06', { until: '2027-01-12' })).toThrow(InvalidSeriesError);
    expect(weeklyDates('2026-01-06', { until: '2026-12-29' })).toHaveLength(52);
    expect(() => weeklyDates('2026-01-06', { weeks: 53 })).toThrow(InvalidSeriesError);
  });
});

describe('resolveSpan', () => {
  it('keeps 19:00 at the club across the end of summer time (25 Oct 2026)', () => {
    const before = resolveSpan('2026-10-20', '19:00', 60, SOFIA);
    const after = resolveSpan('2026-10-27', '19:00', 60, SOFIA);
    expect(before.startTs.toISOString()).toBe('2026-10-20T16:00:00.000Z');
    expect(after.startTs.toISOString()).toBe('2026-10-27T17:00:00.000Z');
    expect(after.endTs.toISOString()).toBe('2026-10-27T18:00:00.000Z');
    expect(before.exists && after.exists).toBe(true);
  });

  it('a time the clocks skip does not exist (29 Mar 2026, 03:00–04:00 in Sofia)', () => {
    expect(resolveSpan('2026-03-29', '03:30', 60, SOFIA).exists).toBe(false);
    expect(resolveSpan('2026-03-29', '04:30', 60, SOFIA).exists).toBe(true);
  });

  it('the repeated hour on the night summer time ends still resolves', () => {
    const span = resolveSpan('2026-10-25', '03:30', 60, SOFIA);
    expect(span.exists).toBe(true);
  });
});

describe('shiftIsoDay', () => {
  it('rolls over leap days', () => {
    expect(shiftIsoDay('2028-02-22', 7)).toBe('2028-02-29');
    expect(shiftIsoDay('2028-02-29', 7)).toBe('2028-03-07');
  });
});
