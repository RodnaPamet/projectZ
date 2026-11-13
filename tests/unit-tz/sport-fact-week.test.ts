import {
  factIndex,
  factIsoWeek,
  factWeekNumber,
  factWeekStart,
  nextFactWeekStart,
} from '@/lib/sports/facts';

/**
 * The fact of the week changes at Monday 00:00 on the Sofia wall clock,
 * whatever zone the server runs in (this suite runs in Honolulu and in
 * Kiritimati) and across a DST change, when that week is an hour shorter or
 * longer.
 */

const at = (iso: string) => new Date(iso);

describe('factIndex: whole Sofia weeks since Monday 2026-01-05, mod 52', () => {
  it('the week of Monday 5 January 2026 is fact 1 (index 0), from its first second', () => {
    // Monday 00:00 in Sofia is 22:00 UTC on the Sunday (EET, +2).
    expect(factWeekStart(at('2026-01-04T22:00:00Z'))).toBe('2026-01-05');
    expect(factIndex(at('2026-01-04T22:00:00Z'))).toBe(0);
    expect(factIndex(at('2026-01-11T21:59:59Z'))).toBe(0);
    expect(factIndex(at('2026-01-11T22:00:00Z'))).toBe(1);
    // One second before is still the Sunday in Sofia: the last of the 52.
    expect(factWeekNumber(at('2026-01-04T21:59:59Z'))).toBe(-1);
    expect(factIndex(at('2026-01-04T21:59:59Z'))).toBe(51);
  });

  it('a Friday belongs to the Monday before it', () => {
    expect(factWeekStart(at('2026-11-13T09:00:00Z'))).toBe('2026-11-09');
    expect(factIndex(at('2026-11-13T09:00:00Z'))).toBe(44);
    // Sunday late evening in Sofia is still the same week.
    expect(factWeekStart(at('2026-11-15T21:59:59Z'))).toBe('2026-11-09');
  });

  it('runs through the 52 and starts again on Monday 4 January 2027', () => {
    expect(factIndex(at('2027-01-03T21:59:59Z'))).toBe(51);
    expect(factIndex(at('2027-01-03T22:00:00Z'))).toBe(0);
  });

  it('changes at Monday 00:00 Sofia in the week the clocks go forward (29 March 2026)', () => {
    // Monday 30 March is summer time: its midnight is 21:00 UTC on the Sunday.
    expect(factIndex(at('2026-03-29T20:59:59Z'))).toBe(11);
    expect(factIndex(at('2026-03-29T21:00:00Z'))).toBe(12);
  });

  it('changes at Monday 00:00 Sofia in the week the clocks go back (25 October 2026)', () => {
    // Monday 26 October is winter time again: its midnight is 22:00 UTC.
    expect(factIndex(at('2026-10-25T21:59:59Z'))).toBe(41);
    expect(factIndex(at('2026-10-25T22:00:00Z'))).toBe(42);
  });
});

describe('nextFactWeekStart: when the fact changes', () => {
  it.each([
    ['2026-11-13T09:00:00Z', '2026-11-15T22:00:00.000Z'],
    // Monday 00:30 in Sofia: the next change is a full week away.
    ['2026-11-15T22:30:00Z', '2026-11-22T22:00:00.000Z'],
    ['2026-03-25T12:00:00Z', '2026-03-29T21:00:00.000Z'],
    ['2026-10-20T12:00:00Z', '2026-10-25T22:00:00.000Z'],
  ])('after %s it is %s', (now, next) => {
    expect(nextFactWeekStart(at(now)).toISOString()).toBe(next);
  });
});

describe('factIsoWeek: the push’s once-a-week key', () => {
  it.each([
    ['2026-01-05T10:00:00Z', '2026-W02'],
    ['2026-11-13T09:00:00Z', '2026-W46'],
    ['2026-12-28T10:00:00Z', '2026-W53'],
    // Sunday 3 January 2027 still belongs to the Monday of 28 December.
    ['2027-01-03T10:00:00Z', '2026-W53'],
    ['2027-01-04T10:00:00Z', '2027-W01'],
  ])('%s is in %s', (now, week) => {
    expect(factIsoWeek(at(now))).toBe(week);
  });
});
