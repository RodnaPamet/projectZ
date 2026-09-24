import { fromZonedTime } from 'date-fns-tz';

import {
  SlotNotBookableError,
  computeSlots,
  quoteBooking,
  type AvailabilityWindow,
  type BookingQuoteOptions,
} from '@/app-layer/usecases/availability';

const SOFIA = 'Europe/Sofia';

/** Open 09:00–17:00 on Wednesdays. 2026-07-15 is a Wednesday. */
const wednesday: AvailabilityWindow[] = [
  { dayOfWeek: 3, openMinutes: 9 * 60, closeMinutes: 17 * 60 },
];

const base: Omit<BookingQuoteOptions, 'startTs' | 'endTs'> = {
  timezone: SOFIA,
  windows: wednesday,
  basePriceCents: 2400,
  minBookingMinutes: 60,
  maxBookingMinutes: 180,
  slotStepMinutes: 30,
};

/** Sofia wall clock on 2026-07-15 → absolute instant. */
const at = (h: number, m = 0) => fromZonedTime(new Date(2026, 6, 15, h, m), SOFIA);

describe('quoteBooking', () => {
  it('prices one unit at the base price', () => {
    expect(quoteBooking({ ...base, startTs: at(9), endTs: at(10) })).toEqual({
      priceCents: 2400,
      units: 1,
    });
  });

  it('charges PER UNIT, not once for the whole span', () => {
    // computePrice knows nothing about duration — basePriceCents is the price
    // of one minBookingMinutes block. Quoting a three-hour booking with a
    // single call would sell three hours for the price of one.
    expect(quoteBooking({ ...base, startTs: at(9), endTs: at(12) })).toEqual({
      priceCents: 7200,
      units: 3,
    });
  });

  it('applies a time-of-day rule only to the units it actually covers', () => {
    // A booking running from off-peak into peak must pick up the peak rate for
    // the peak part. Pricing the whole span by its START time would sell the
    // evening at the afternoon rate — which is the club's money.
    const quote = quoteBooking({
      ...base,
      startTs: at(17 - 2), // 15:00
      endTs: at(17),
      windows: [{ dayOfWeek: 3, openMinutes: 9 * 60, closeMinutes: 17 * 60 }],
      pricingRules: [
        {
          id: 'peak',
          name: 'Evening peak',
          priority: 200,
          conditionsJson: { timeRange: { from: '16:00', to: '22:00' } },
          multiplier: 2,
          fixedPriceCents: null,
        },
      ],
    });

    // 15:00–16:00 at 2400, 16:00–17:00 at 4800.
    expect(quote).toEqual({ priceCents: 7200, units: 2 });
  });

  it('agrees with the price availability advertised for the same slot', () => {
    // THE consistency property. If these two ever diverge, the app shows one
    // number and charges another — and nothing fails, so nobody finds out
    // until a player complains.
    const rules = [
      {
        id: 'weekday-morning',
        name: 'Morning',
        priority: 150,
        conditionsJson: { timeRange: { from: '09:00', to: '12:00' } },
        multiplier: 0.5,
        fixedPriceCents: null,
      },
    ];

    const slots = computeSlots({
      from: fromZonedTime(new Date(2026, 6, 15, 0, 0), SOFIA),
      to: fromZonedTime(new Date(2026, 6, 16, 0, 0), SOFIA),
      timezone: SOFIA,
      slotStepMinutes: 30,
      minBookingMinutes: 60,
      basePriceCents: 2400,
      windows: wednesday,
      booked: [],
      pricingRules: rules,
    });

    for (const slot of slots) {
      const quote = quoteBooking({
        ...base,
        pricingRules: rules,
        startTs: slot.startTs,
        endTs: slot.endTs,
      });

      expect(quote.priceCents).toBe(slot.priceCents);
    }
  });

  it.each([
    ['before opening', 8, 9],
    ['past closing', 16, 18],
    ['entirely outside', 20, 21],
  ])('rejects a booking %s', (_label, startHour, endHour) => {
    expect(() => quoteBooking({ ...base, startTs: at(startHour), endTs: at(endHour) })).toThrow(
      SlotNotBookableError,
    );
  });

  it('rejects a start that does not fall on a step from OPENING', () => {
    // Steps are measured from the window's opening, not midnight: a club
    // opening at 09:15 offers 09:15 and 09:45, never 09:30.
    const quarterPast: AvailabilityWindow[] = [
      { dayOfWeek: 3, openMinutes: 9 * 60 + 15, closeMinutes: 17 * 60 },
    ];

    expect(() =>
      quoteBooking({ ...base, windows: quarterPast, startTs: at(9, 30), endTs: at(10, 30) }),
    ).toThrow(SlotNotBookableError);

    expect(
      quoteBooking({ ...base, windows: quarterPast, startTs: at(9, 45), endTs: at(10, 45) }).units,
    ).toBe(1);
  });

  it('rejects a duration that is not a whole number of units', () => {
    // 90 minutes with a 60-minute minimum. Allowing it would mean deciding how
    // to price half a unit, and every answer is a guess about the club.
    expect(() => quoteBooking({ ...base, startTs: at(9), endTs: at(10, 30) })).toThrow(
      SlotNotBookableError,
    );
  });

  it('rejects spans shorter than the minimum and longer than the maximum', () => {
    expect(() => quoteBooking({ ...base, startTs: at(9), endTs: at(9, 30) })).toThrow(
      SlotNotBookableError,
    );
    expect(() => quoteBooking({ ...base, startTs: at(9), endTs: at(13) })).toThrow(
      SlotNotBookableError,
    );
  });

  it('refuses to bridge a midday closure', () => {
    // Two windows with a gap is two bookings, not one long one. A span that
    // covers the gap would have the player paying for court time the club is
    // shut for.
    const split: AvailabilityWindow[] = [
      { dayOfWeek: 3, openMinutes: 9 * 60, closeMinutes: 12 * 60 },
      { dayOfWeek: 3, openMinutes: 14 * 60, closeMinutes: 18 * 60 },
    ];

    expect(() => quoteBooking({ ...base, windows: split, startTs: at(11), endTs: at(14) })).toThrow(
      SlotNotBookableError,
    );

    // …but either side on its own is fine.
    expect(quoteBooking({ ...base, windows: split, startTs: at(11), endTs: at(12) }).units).toBe(1);
  });

  it('honours a closure exception for that date', () => {
    const closed: AvailabilityWindow[] = [
      ...wednesday,
      {
        dayOfWeek: 3,
        openMinutes: 0,
        closeMinutes: 0,
        exceptionDate: new Date('2026-07-15T00:00:00Z'),
      },
    ];

    expect(() => quoteBooking({ ...base, windows: closed, startTs: at(9), endTs: at(10) })).toThrow(
      SlotNotBookableError,
    );
  });

  it('rejects a start that is not on a whole minute, and SAYS so', () => {
    // An ordinary Wednesday in July, nowhere near a changeover.
    //
    // The round-trip guard rebuilds the start from getHours()/getMinutes(),
    // which cannot represent seconds, so a sub-minute start never round-trips
    // and was rejected as an impossible wall clock. A client deriving startTs
    // from Date.now() arithmetic, or echoing a timestamp that kept its
    // seconds, got a 400 blaming DST on 15 July.
    const wednesday: AvailabilityWindow[] = [
      { dayOfWeek: 3, openMinutes: 6 * 60, closeMinutes: 22 * 60 },
    ];

    expect(() =>
      quoteBooking({
        ...base,
        windows: wednesday,
        startTs: new Date('2026-07-15T06:00:30Z'),
        endTs: new Date('2026-07-15T07:00:30Z'),
      }),
    ).toThrow(/whole minute/);

    // Milliseconds alone are enough — a client doing Date.now() arithmetic
    // never sees the seconds it is carrying.
    expect(() =>
      quoteBooking({
        ...base,
        windows: wednesday,
        startTs: new Date('2026-07-15T06:00:00.500Z'),
        endTs: new Date('2026-07-15T07:00:00.500Z'),
      }),
    ).toThrow(/whole minute/);

    // And the same span on the minute is fine, so the guard is not rejecting
    // the window or the day.
    expect(
      quoteBooking({
        ...base,
        windows: wednesday,
        startTs: new Date('2026-07-15T06:00:00Z'),
        endTs: new Date('2026-07-15T07:00:00Z'),
      }).priceCents,
    ).toBeGreaterThan(0);
  });

  it('rejects an AMBIGUOUS wall-clock time, and accepts the unambiguous one', () => {
    // Sofia's clocks go back on 2026-10-25, so 03:30 local happens twice —
    // once at 00:30Z and again at 01:30Z. Rebuilding the instant from the wall
    // clock resolves to 01:30Z, so accepting the first occurrence would price
    // it against one instant and check it for clashes against another an hour
    // away. The player's booking would not be when they think it is.
    //
    // A SKIPPED wall clock needs no guard: it corresponds to no instant at
    // all, so a client has no way to send one.
    const sunday: AvailabilityWindow[] = [{ dayOfWeek: 0, openMinutes: 0, closeMinutes: 23 * 60 }];

    const firstOccurrence = new Date('2026-10-25T00:30:00Z');
    const secondOccurrence = new Date('2026-10-25T01:30:00Z');

    expect(
      () =>
        quoteBooking({
          ...base,
          windows: sunday,
          startTs: firstOccurrence,
          endTs: new Date(firstOccurrence.getTime() + 3_600_000),
        }),
      // The REASON, not just the class. A class-only assertion is what let a
      // sub-minute start hide behind this guard for so long: it threw the same
      // error with a message about a date nobody had asked for.
    ).toThrow(/ambiguous/);

    expect(
      quoteBooking({
        ...base,
        windows: sunday,
        startTs: secondOccurrence,
        endTs: new Date(secondOccurrence.getTime() + 3_600_000),
      }).units,
    ).toBe(1);
  });

  it('rejects a backwards or zero-length span', () => {
    expect(() => quoteBooking({ ...base, startTs: at(10), endTs: at(9) })).toThrow(
      SlotNotBookableError,
    );
    expect(() => quoteBooking({ ...base, startTs: at(10), endTs: at(10) })).toThrow(
      SlotNotBookableError,
    );
  });
});
