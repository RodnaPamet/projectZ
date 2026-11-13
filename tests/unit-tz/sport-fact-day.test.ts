import { factIndex, nextStoryMidnight, storyDay, storyDayNumber } from '@/lib/sports/stories';

/**
 * The fact of the day changes at midnight on the Sofia wall clock, whatever
 * zone the server runs in (this suite runs in Honolulu and in Kiritimati) and
 * on either side of a DST change, when a Sofia day is 23 or 25 hours long.
 */

const at = (iso: string) => new Date(iso);

describe('factIndex: Sofia days since 2026-01-01, mod 52', () => {
  it('1 January 2026 in Sofia is fact 1 (index 0), from its first second', () => {
    // 00:00 in Sofia on 1 January is 22:00 UTC the evening before (EET, +2).
    expect(storyDay(at('2025-12-31T22:00:00Z'))).toBe('2026-01-01');
    expect(factIndex(at('2025-12-31T22:00:00Z'))).toBe(0);
    expect(factIndex(at('2026-01-01T21:59:59Z'))).toBe(0);
    // One second earlier is still 31 December in Sofia: the last of the 52.
    expect(storyDayNumber(at('2025-12-31T21:59:59Z'))).toBe(-1);
    expect(factIndex(at('2025-12-31T21:59:59Z'))).toBe(51);
  });

  it('runs through the 52 and starts again', () => {
    expect(factIndex(at('2026-02-21T12:00:00Z'))).toBe(51); // day 51
    expect(factIndex(at('2026-02-22T12:00:00Z'))).toBe(0); // day 52
    expect(factIndex(at('2026-12-31T12:00:00Z'))).toBe(364 % 52);
  });

  it('changes at midnight Sofia on the day the clocks go forward (29 March 2026)', () => {
    // 28 March is still winter time: midnight into the 29th is 22:00 UTC.
    expect(factIndex(at('2026-03-28T21:59:59Z'))).toBe(86 % 52);
    expect(factIndex(at('2026-03-28T22:00:00Z'))).toBe(87 % 52);
    // The 29th is 23 hours long: midnight into the 30th is 21:00 UTC (EEST, +3).
    expect(factIndex(at('2026-03-29T20:59:59Z'))).toBe(87 % 52);
    expect(factIndex(at('2026-03-29T21:00:00Z'))).toBe(88 % 52);
  });

  it('changes at midnight Sofia on the day the clocks go back (25 October 2026)', () => {
    // Midnight into the 25th is still summer time: 21:00 UTC on the 24th.
    expect(factIndex(at('2026-10-24T20:59:59Z'))).toBe(296 % 52);
    expect(factIndex(at('2026-10-24T21:00:00Z'))).toBe(297 % 52);
    // The 25th is 25 hours long: midnight into the 26th is 22:00 UTC.
    expect(factIndex(at('2026-10-25T21:59:59Z'))).toBe(297 % 52);
    expect(factIndex(at('2026-10-25T22:00:00Z'))).toBe(298 % 52);
  });
});

describe('nextStoryMidnight: when the fact changes', () => {
  it.each([
    ['2026-11-13T09:00:00Z', '2026-11-13T22:00:00.000Z'],
    ['2026-11-13T22:30:00Z', '2026-11-14T22:00:00.000Z'],
    ['2026-03-28T12:00:00Z', '2026-03-28T22:00:00.000Z'],
    ['2026-03-29T12:00:00Z', '2026-03-29T21:00:00.000Z'],
    ['2026-10-25T12:00:00Z', '2026-10-25T22:00:00.000Z'],
    ['2026-12-31T21:59:00Z', '2026-12-31T22:00:00.000Z'],
  ])('after %s it is %s', (now, next) => {
    expect(nextStoryMidnight(at(now)).toISOString()).toBe(next);
  });
});
