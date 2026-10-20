import type { ResourceSlotsDto } from '@/app/api/v1/_lib/dto';
import { courtAt, laterOffers, planLengths, planTimes } from '@/lib/venues/plan-slots';

/** Time first, then the plan (#625): the starts, the lengths, each court's state. */

const AT = (h: number) => `2036-07-16T${String(h).padStart(2, '0')}:00:00Z`;
const NOW = Date.parse(AT(7));

/** A court open 08:00–12:00 in hours, free at `free`, bookable for `lengths`. */
function court(id: string, free: number[], lengths: number[] = [60]): ResourceSlotsDto {
  return {
    resourceId: id,
    name: id,
    sport: 'PADEL',
    resourceType: 'COURT',
    currency: 'EUR',
    minBookingMinutes: lengths[0]!,
    maxBookingMinutes: lengths[lengths.length - 1]!,
    slotStepMinutes: 60,
    slots: [8, 9, 10, 11].map((h) => ({
      startTs: AT(h),
      endTs: AT(h + 1),
      priceCents: 2000,
      available: free.includes(h),
      durations: lengths.map((m) => ({
        minutes: m,
        endTs: AT(h + m / 60),
        priceCents: 2000 * (m / 60),
      })),
    })),
  };
}

describe('planLengths', () => {
  it('is every length any court allows, shortest first', () => {
    expect(planLengths([court('a', [], [60, 120]), court('b', [], [90])])).toEqual([60, 90, 120]);
    expect(planLengths([])).toEqual([]);
  });
});

describe('planTimes', () => {
  it('is every start at which some court is free for that length, in order', () => {
    const courts = [court('a', [10, 8]), court('b', [9, 10])];
    expect(planTimes(courts, 60, NOW)).toEqual([AT(8), AT(9), AT(10)]);
  });

  it('leaves out starts already begun, and lengths no court allows', () => {
    const courts = [court('a', [8, 9, 10])];
    expect(planTimes(courts, 60, Date.parse(AT(9)))).toEqual([AT(10)]);
    expect(planTimes(courts, 90, NOW)).toEqual([]);
  });
});

describe('courtAt', () => {
  it('is free with the list’s own offer, or not free', () => {
    const a = court('a', [9], [60, 120]);
    expect(courtAt(a, 120, AT(9), NOW)).toEqual({
      free: true,
      offer: { startTs: AT(9), endTs: AT(11), minutes: 120, priceCents: 4000 },
    });
    expect(courtAt(a, 60, AT(10), NOW)).toEqual({ free: false });
    expect(courtAt(a, 60, null, NOW)).toEqual({ free: false });
  });
});

describe('laterOffers', () => {
  it('is the next free starts after the picked one, at most three', () => {
    const a = court('a', [8, 9, 10, 11]);
    expect(laterOffers(a, 60, AT(8), NOW).map((o) => o.startTs)).toEqual([AT(9), AT(10), AT(11)]);
    expect(laterOffers(a, 60, AT(8), NOW, 1).map((o) => o.startTs)).toEqual([AT(9)]);
    expect(laterOffers(a, 60, AT(11), NOW)).toEqual([]);
  });

  it('falls back to the court’s own shortest length when it does not allow the picked one', () => {
    const b = court('b', [10], [90]);
    expect(laterOffers(b, 60, AT(8), NOW)).toEqual([
      { startTs: AT(10), endTs: AT(11.5), minutes: 90, priceCents: 3000 },
    ]);
  });
});
