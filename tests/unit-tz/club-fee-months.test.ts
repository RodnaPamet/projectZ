import {
  addMonthsToDate,
  clubDateOf,
  defaultFeeStartsOn,
  freePeriodCover,
  isInFreePeriod,
  monthBounds,
  monthsBack,
  shiftMonth,
  statementMonthOf,
} from '@/lib/billing/club-fee';

/**
 * The club fee's calendar (#372), run from a host west of Greenwich AND one
 * east of it (`npm run test:tz`): a statement month is a month IN SOFIA, and
 * nothing here may lean on the server's own zone.
 */

describe('statement months are Sofia months', () => {
  it('a booking at 00:30 on 1 November in Sofia is November, though it is still 31 October in UTC', () => {
    // 1 Nov 2026 00:30 EET (+02:00, after the 25 October change) = 31 Oct 22:30Z.
    expect(statementMonthOf(new Date('2026-10-31T22:30:00Z'))).toBe('2026-11');
    // One hour earlier is 23:30 on 31 October in Sofia.
    expect(statementMonthOf(new Date('2026-10-31T21:30:00Z'))).toBe('2026-10');
  });

  it('a booking at 00:30 on 1 October in Sofia (summer time, +03:00) is October', () => {
    expect(statementMonthOf(new Date('2026-09-30T21:30:00Z'))).toBe('2026-10');
    expect(statementMonthOf(new Date('2026-09-30T20:30:00Z'))).toBe('2026-09');
  });

  it('the night of the 25 October change stays in October on both sides of 04:00', () => {
    // 03:30 EEST (00:30Z), then the clocks go back: 03:30 EET (01:30Z).
    expect(statementMonthOf(new Date('2026-10-25T00:30:00Z'))).toBe('2026-10');
    expect(statementMonthOf(new Date('2026-10-25T01:30:00Z'))).toBe('2026-10');
    expect(clubDateOf(new Date('2026-10-25T01:30:00Z'))).toBe('2026-10-25');
  });

  it("October's bounds carry two different offsets", () => {
    const { start, end } = monthBounds('2026-10');
    expect(start.toISOString()).toBe('2026-09-30T21:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-31T22:00:00.000Z');
    // 31 days, plus the hour the clocks gave back.
    expect(end.getTime() - start.getTime()).toBe((31 * 24 + 1) * 3_600_000);
  });

  it('shifts months across a year', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(monthsBack('2026-08', '2026-10')).toEqual(['2026-10', '2026-09', '2026-08']);
    expect(monthsBack('2027-01', '2026-10')).toEqual(['2026-10']);
    expect(monthsBack('2000-01', '2026-10', 3)).toEqual(['2026-10', '2026-09', '2026-08']);
  });
});

describe('the free period', () => {
  it('defaults to two months from the day the club was created, at the club', () => {
    // Created 23:30 on 6 October Sofia time = 20:30Z: the Sofia date is the 6th.
    expect(defaultFeeStartsOn(new Date('2026-10-06T20:30:00Z'))).toBe('2026-12-06');
    // 22:30Z on the 6th is already the 7th in Sofia.
    expect(defaultFeeStartsOn(new Date('2026-10-06T22:30:00Z'))).toBe('2026-12-07');
  });

  it('clamps to the end of a shorter month', () => {
    expect(addMonthsToDate('2026-12-31', 2)).toBe('2027-02-28');
    expect(addMonthsToDate('2027-12-31', 2)).toBe('2028-02-29');
  });

  it('covers a booking that STARTS before the first charged day, at the club', () => {
    // 23:30 on 30 November in Sofia (21:30Z): still free if charging starts 1 December.
    expect(isInFreePeriod(new Date('2026-11-30T21:30:00Z'), '2026-12-01')).toBe(true);
    // 00:30 on 1 December in Sofia (22:30Z on the 30th): charged.
    expect(isInFreePeriod(new Date('2026-11-30T22:30:00Z'), '2026-12-01')).toBe(false);
  });

  it('says how much of a month it covers', () => {
    expect(freePeriodCover('2026-11', '2026-12-01')).toBe('all');
    expect(freePeriodCover('2026-12', '2026-12-01')).toBe('none');
    expect(freePeriodCover('2026-12', '2026-12-15')).toBe('part');
    expect(freePeriodCover('2026-12', '2027-01-01')).toBe('all');
  });
});
