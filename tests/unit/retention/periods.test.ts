import {
  RETENTION,
  daysBefore,
  retentionCutoffs,
  utcDay,
  utcWall,
  yearsBefore,
} from '@/lib/retention/periods';

/**
 * The privacy policy's periods (#717), as the sweep computes them. The
 * numbers are pinned here so a change to one is a change to this test as well
 * as to content/legal/{bg,en}/privacy.md.
 */
describe('retention periods', () => {
  it('match the privacy policy, section 13', () => {
    expect(RETENTION).toEqual({
      bookingYears: 5,
      auditYears: 5,
      moderationYears: 5,
      acceptedTextsAfterDeletionYears: 5,
      contactRequestYears: 2,
      securityEventYears: 1,
      creditYears: 5,
      sessionDays: 90,
    });
  });
});

describe('yearsBefore', () => {
  it('goes back whole calendar years, keeping the time of day', () => {
    expect(yearsBefore(new Date('2026-11-26T03:04:05.678Z'), 5).toISOString()).toBe(
      '2021-11-26T03:04:05.678Z',
    );
  });

  it('lands 29 February on 28 February, as Postgres does', () => {
    // Postgres: SELECT timestamp '2032-02-29 10:00' - interval '5 years' → 2027-02-28 10:00.
    expect(yearsBefore(new Date('2032-02-29T10:00:00Z'), 5).toISOString()).toBe(
      '2027-02-28T10:00:00.000Z',
    );
    expect(yearsBefore(new Date('2028-02-29T00:00:00Z'), 1).toISOString()).toBe(
      '2027-02-28T00:00:00.000Z',
    );
  });

  it('keeps 29 February when the earlier year is a leap year too', () => {
    expect(yearsBefore(new Date('2032-02-29T10:00:00Z'), 4).toISOString()).toBe(
      '2028-02-29T10:00:00.000Z',
    );
  });

  it('crosses a year boundary by UTC, not by the machine’s zone', () => {
    expect(yearsBefore(new Date('2027-01-01T00:30:00Z'), 2).toISOString()).toBe(
      '2025-01-01T00:30:00.000Z',
    );
  });

  it('does not change its argument', () => {
    const now = new Date('2026-11-26T00:00:00Z');
    yearsBefore(now, 5);
    expect(now.toISOString()).toBe('2026-11-26T00:00:00.000Z');
  });
});

describe('daysBefore', () => {
  it('is days of 24 hours', () => {
    expect(daysBefore(new Date('2026-11-26T12:00:00Z'), 90).toISOString()).toBe(
      '2026-08-28T12:00:00.000Z',
    );
  });
});

describe('retentionCutoffs', () => {
  it('gives every category its own cut-off', () => {
    const c = retentionCutoffs(new Date('2026-11-26T12:00:00Z'));
    expect(c).toEqual({
      bookingsEndedBefore: new Date('2021-11-26T12:00:00Z'),
      auditBefore: new Date('2021-11-26T12:00:00Z'),
      moderationBefore: new Date('2021-11-26T12:00:00Z'),
      acceptedTextsDeletedBefore: new Date('2021-11-26T12:00:00Z'),
      contactBefore: new Date('2024-11-26T12:00:00Z'),
      securityEventsBefore: new Date('2025-11-26T12:00:00Z'),
      sessionsEndedBefore: new Date('2026-08-28T12:00:00Z'),
      creditLastMovementBefore: new Date('2021-11-26T12:00:00Z'),
    });
  });
});

describe('SQL text', () => {
  it('writes a UTC wall clock and a UTC day', () => {
    const d = new Date('2021-11-26T23:59:59.123Z');
    expect(utcWall(d)).toBe('2021-11-26T23:59:59.123');
    expect(utcDay(d)).toBe('2021-11-26');
  });
});
