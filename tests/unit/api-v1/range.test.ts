import { MAX_RANGE_DAYS, RangeTooWideError } from '@/app-layer/usecases/availability';
import { resolveAvailabilityRange } from '@/app/api/v1/_lib/range';
import { ValidationError } from '@/lib/errors/types';

const SOFIA = 'Europe/Sofia';

const q = (s: string) => new URLSearchParams(s);

describe('resolveAvailabilityRange', () => {
  it('reads ?date as a calendar date AT THE CLUB', () => {
    // Sofia is UTC+3 in July, so the local day starts at 21:00Z the day
    // before. Resolving this in UTC — or worse, on the client, in the
    // DEVICE's zone — shifts the whole window by the offset.
    const { from, to } = resolveAvailabilityRange(q('date=2026-07-15'), SOFIA);

    expect(from.toISOString()).toBe('2026-07-14T21:00:00.000Z');
    expect(to.toISOString()).toBe('2026-07-15T21:00:00.000Z');
  });

  it('a multi-day window is whole LOCAL days, even across a changeover', () => {
    // 25 October 2026 is 25 hours long in Sofia. Adding days as fixed 24-hour
    // blocks would end this window an hour early and silently drop the last
    // evening's slots.
    const { from, to } = resolveAvailabilityRange(q('date=2026-10-24&days=3'), SOFIA);

    expect(from.toISOString()).toBe('2026-10-23T21:00:00.000Z');
    // 24th (24h) + 25th (25h) + 26th (24h) = 73 hours.
    expect((to.getTime() - from.getTime()) / 3_600_000).toBe(73);
  });

  it('accepts explicit instants for a caller that means them', () => {
    const { from, to } = resolveAvailabilityRange(
      q('from=2026-07-15T06:00:00Z&to=2026-07-15T12:00:00Z'),
      SOFIA,
    );

    expect(from.toISOString()).toBe('2026-07-15T06:00:00.000Z');
    expect(to.toISOString()).toBe('2026-07-15T12:00:00.000Z');
  });

  it('defaults to the next 24 hours', () => {
    const now = new Date('2026-07-15T10:00:00Z');
    const { from, to } = resolveAvailabilityRange(q(''), SOFIA, now);

    expect(from).toEqual(now);
    expect(to.toISOString()).toBe('2026-07-16T10:00:00.000Z');
  });

  it('REJECTS date and from/to together instead of silently picking one', () => {
    // Preferring one would make the other a no-op that looks like it worked.
    expect(() =>
      resolveAvailabilityRange(q('date=2026-07-15&from=2026-07-01T00:00:00Z'), SOFIA),
    ).toThrow(ValidationError);
  });

  it.each([
    ['15-07-2026', 'a day-first date'],
    ['2026-7-15', 'an unpadded month'],
    ['not-a-date', 'nonsense'],
  ])('rejects %s (%s)', (date) => {
    expect(() => resolveAvailabilityRange(q(`date=${date}`), SOFIA)).toThrow(ValidationError);
  });

  it.each([
    ['0', 'zero'],
    ['15', 'past the engine ceiling'],
    ['2.5', 'fractional'],
    ['', 'empty — Number("") is 0, which parseInt would not catch'],
  ])('rejects days=%s (%s)', (days) => {
    expect(() => resolveAvailabilityRange(q(`date=2026-07-15&days=${days}`), SOFIA)).toThrow(
      ValidationError,
    );
  });

  it('rejects a backwards or empty window', () => {
    expect(() =>
      resolveAvailabilityRange(q('from=2026-07-15T12:00:00Z&to=2026-07-15T06:00:00Z'), SOFIA),
    ).toThrow(ValidationError);

    expect(() =>
      resolveAvailabilityRange(q('from=2026-07-15T12:00:00Z&to=2026-07-15T12:00:00Z'), SOFIA),
    ).toThrow(ValidationError);
  });

  it('rejects an unparseable instant rather than yielding an Invalid Date', () => {
    // `new Date('tomorrow')` is NaN, and every downstream comparison against
    // NaN is false — so an unguarded parse produces an empty slot list that
    // looks like a fully booked club.
    expect(() => resolveAvailabilityRange(q('from=tomorrow'), SOFIA)).toThrow(ValidationError);
  });

  describe('the from/to path is bounded, not just ordered', () => {
    // It used to check `to > from` and nothing else. The route queries
    // bookings BEFORE computing slots, so `MAX_RANGE_DAYS` — enforced inside
    // `computeSlots` — came too late to bound the database. An unauthenticated
    // GET could ask for twenty years across every court in the venue.

    it('rejects a range wider than the ceiling', () => {
      expect(() =>
        resolveAvailabilityRange(q('from=2016-01-01T00:00:00Z&to=2036-01-01T00:00:00Z'), SOFIA),
      ).toThrow(RangeTooWideError);
    });

    it('rejects it as RANGE_TOO_WIDE, not as a validation error', () => {
      // The client can act on "you asked for too much" and cannot act on a
      // generic 400 — and it must not be the 500 a venue past the booking
      // tripwire used to get.
      try {
        resolveAvailabilityRange(q('from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z'), SOFIA);
        throw new Error('expected a throw');
      } catch (err) {
        expect(err).toBeInstanceOf(RangeTooWideError);
        expect(err).not.toBeInstanceOf(ValidationError);
        expect((err as Error).message).toMatch(/the maximum is 14/);
      }
    });

    it('accepts exactly the ceiling', () => {
      // The boundary is the whole point of a ceiling. Rejecting 14 days would
      // break the longest legitimate request the API advertises.
      const from = '2026-07-01T00:00:00Z';
      const to = new Date(Date.parse(from) + MAX_RANGE_DAYS * 86_400_000).toISOString();

      expect(() => resolveAvailabilityRange(q(`from=${from}&to=${to}`), SOFIA)).not.toThrow();
    });

    it('still tolerates the DST hour at the ceiling', () => {
      // A 14-day window spanning the October changeover measures 14 days and
      // one hour. Measuring in fixed 86_400_000ms days would reject it — in
      // late October only, which is exactly the bug nobody finds in July.
      const from = '2026-10-18T00:00:00Z';
      const to = new Date(Date.parse(from) + MAX_RANGE_DAYS * 86_400_000 + 3_600_000).toISOString();

      expect(() => resolveAvailabilityRange(q(`from=${from}&to=${to}`), SOFIA)).not.toThrow();
    });

    it('rejects an open-ended `from` that would run to the default window only', () => {
      // `?from=` with no `?to=` defaults to a 24-hour window, so it is bounded
      // already. Pinned so a future "default to the venue's whole calendar"
      // change has to come past this test.
      const { from, to } = resolveAvailabilityRange(q('from=2026-07-01T00:00:00Z'), SOFIA);
      expect(to.getTime() - from.getTime()).toBe(86_400_000);
    });
  });
});
