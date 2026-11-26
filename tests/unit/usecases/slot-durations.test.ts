import {
  quoteBooking,
  slotDurations,
  type AvailabilityWindow,
} from '@/app-layer/usecases/availability';

const SOFIA = 'Europe/Sofia';

/** Open 09:00–17:00 every day, venue-local. */
const openAllWeek: AvailabilityWindow[] = Array.from({ length: 7 }, (_, dayOfWeek) => ({
  dayOfWeek,
  openMinutes: 9 * 60,
  closeMinutes: 17 * 60,
}));

const base = {
  timezone: SOFIA,
  windows: openAllWeek,
  basePriceCents: 1000,
  minBookingMinutes: 60,
  maxBookingMinutes: 180,
  slotStepMinutes: 30,
  booked: [],
};

// 2026-07-15, Sofia is UTC+3: 09:00 local = 06:00Z.
const at = (hh: number, mm = 0) => new Date(Date.UTC(2026, 6, 15, hh - 3, mm));

describe('slotDurations (Q16)', () => {
  it('offers whole units of the minimum, up to the maximum, shortest first', () => {
    const out = slotDurations(at(9), base);
    expect(out.map((d) => d.minutes)).toEqual([60, 120, 180]);
    expect(out.map((d) => d.endTs)).toEqual([at(10), at(11), at(12)]);
  });

  it('prices each length exactly as quoteBooking — the function the booking charges with', () => {
    const pricingRules = [
      {
        id: 'peak',
        name: 'Evening',
        priority: 100,
        conditionsJson: { timeRange: { from: '10:00', to: '17:00' } },
        multiplier: 2 as never,
        fixedPriceCents: null,
      },
    ];
    for (const d of slotDurations(at(9), { ...base, pricingRules })) {
      const quote = quoteBooking({ ...base, pricingRules, startTs: at(9), endTs: d.endTs });
      expect(d.priceCents).toBe(quote.priceCents);
    }
  });

  it('stops at closing time', () => {
    expect(slotDurations(at(15), base).map((d) => d.minutes)).toEqual([60, 120]);
    expect(slotDurations(at(16), base).map((d) => d.minutes)).toEqual([60]);
  });

  it('stops at the next booking — a longer span only overlaps more', () => {
    const booked = [{ startTs: at(11), endTs: at(12) }];
    expect(slotDurations(at(9), { ...base, booked }).map((d) => d.minutes)).toEqual([60, 120]);
    expect(slotDurations(at(10, 30), { ...base, booked })).toEqual([]);
  });

  it('back-to-back with a booking is not a clash, as in the EXCLUDE constraint', () => {
    const booked = [{ startTs: at(8), endTs: at(9) }];
    expect(slotDurations(at(9), { ...base, booked })).toHaveLength(3);
  });

  it('offers nothing off the start grid', () => {
    expect(slotDurations(at(9, 15), base)).toEqual([]);
  });

  it('offers only the minimum when the maximum equals it', () => {
    expect(slotDurations(at(9), { ...base, maxBookingMinutes: 60 })).toHaveLength(1);
  });

  // #701: the time-zone work moved to once per start. Every length of every
  // start on the autumn fall-back day must still match quoteBooking exactly,
  // and a start quoteBooking refuses must offer nothing.
  it('matches quoteBooking for every start and length across the fall-back day', () => {
    const nightOwl: AvailabilityWindow[] = Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      openMinutes: 0,
      closeMinutes: 24 * 60,
    }));
    const pricingRules = [
      {
        id: 'night',
        name: 'Night',
        priority: 100,
        conditionsJson: { timeRange: { from: '02:00', to: '05:00' } },
        multiplier: 3 as never,
        fixedPriceCents: null,
      },
    ];
    const opts = { ...base, windows: nightOwl, pricingRules };
    // 2026-10-25: Sofia falls back from UTC+3 to UTC+2 at 04:00 local.
    const start = Date.UTC(2026, 9, 24, 21, 0);
    let refused = 0;
    for (let t = start; t < start + 25 * 3_600_000; t += 30 * 60_000) {
      const startTs = new Date(t);
      const offered = slotDurations(startTs, opts);
      const expected: Array<{ minutes: number; priceCents: number }> = [];
      for (let minutes = 60; minutes <= 180; minutes += 60) {
        try {
          const quote = quoteBooking({
            ...opts,
            startTs,
            endTs: new Date(t + minutes * 60_000),
          });
          expected.push({ minutes, priceCents: quote.priceCents });
        } catch {
          break;
        }
      }
      if (expected.length === 0) refused++;
      expect(offered.map((d) => ({ minutes: d.minutes, priceCents: d.priceCents }))).toEqual(
        expected,
      );
    }
    // The doubled 03:00–04:00 hour is ambiguous: its starts are refused.
    expect(refused).toBeGreaterThan(0);
  });
});
