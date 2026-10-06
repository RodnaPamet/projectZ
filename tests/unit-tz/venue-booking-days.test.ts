import {
  BOOKING_DAYS,
  bookingDays,
  isPublicSlug,
  parseInitialPick,
  venuePagePath,
} from '@/app/(public)/venues/[slug]/booking-days';

/**
 * The venue page's day picker counts the CLUB's days (#355), whatever zone
 * the server runs in. `npm run test:tz` runs this from both sides of
 * Greenwich (Honolulu, Kiritimati), where a host-local day is wrong by up to
 * a day either way.
 */
const SOFIA = 'Europe/Sofia';

describe('bookingDays', () => {
  it('is today at the club plus 13 calendar days', () => {
    const days = bookingDays(new Date('2026-07-15T10:00:00Z'), SOFIA);
    expect(days).toHaveLength(BOOKING_DAYS);
    expect(days[0]).toBe('2026-07-15');
    expect(days[13]).toBe('2026-07-28');
  });

  it('turns over at Sofia midnight, not UTC midnight or the host’s', () => {
    // 23:30 UTC on the 14th is 02:30 on the 15th in Sofia (UTC+3).
    expect(bookingDays(new Date('2026-07-14T23:30:00Z'), SOFIA)[0]).toBe('2026-07-15');
    // 20:59 UTC is 23:59 in Sofia: still the 14th.
    expect(bookingDays(new Date('2026-07-14T20:59:00Z'), SOFIA)[0]).toBe('2026-07-14');
  });

  it('crosses the October changeover as whole calendar days', () => {
    const days = bookingDays(new Date('2026-10-20T12:00:00Z'), SOFIA);
    expect(days.slice(4, 7)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
    expect(new Set(days).size).toBe(BOOKING_DAYS);
  });

  it('crosses a month and a year end', () => {
    const days = bookingDays(new Date('2026-12-25T12:00:00Z'), SOFIA);
    expect(days.at(-1)).toBe('2027-01-07');
  });
});

describe('the URL pick', () => {
  const days = bookingDays(new Date('2026-07-15T10:00:00Z'), SOFIA);

  it('keeps a day within the 14 and a well-formed slot', () => {
    expect(
      parseInitialPick(
        {
          day: '2026-07-17',
          court: 'ckcourt1',
          start: '2026-07-17T15:00:00.000Z',
          min: '90',
          confirm: '1',
        },
        days,
      ),
    ).toEqual({
      day: '2026-07-17',
      court: 'ckcourt1',
      start: '2026-07-17T15:00:00Z',
      minutes: 90,
      confirm: true,
    });
  });

  it('falls back to today for a day outside the window or malformed', () => {
    for (const day of ['2026-07-14', '2026-07-29', 'tomorrow', ['2026-07-16', '2026-07-17']]) {
      expect(parseInitialPick({ day }, days).day).toBe('2026-07-15');
    }
  });

  it('drops a slot that is half there, and never confirms without one', () => {
    expect(parseInitialPick({ court: 'c1', confirm: '1' }, days)).toMatchObject({
      court: null,
      start: null,
      confirm: false,
    });
    expect(parseInitialPick({ court: '../x', start: '2026-07-17T15:00:00Z' }, days).court).toBe(
      null,
    );
    expect(parseInitialPick({ court: 'c1', start: 'soon' }, days).start).toBe(null);
  });
});

describe('venuePagePath — the sign-in return URL', () => {
  it('is a path on this page, never anything the visitor typed', () => {
    const path = venuePagePath('slot-club', {
      day: '2026-07-17',
      court: 'c1',
      start: '2026-07-17T15:00:00Z',
      minutes: 60,
      confirm: true,
    });
    expect(path).toBe(
      '/venues/slot-club?day=2026-07-17&court=c1&start=2026-07-17T15%3A00%3A00Z&min=60&confirm=1',
    );
    expect(path.startsWith('/venues/')).toBe(true);
  });

  it('carries only the day without a slot', () => {
    expect(venuePagePath('slot-club', { day: '2026-07-17', confirm: true })).toBe(
      '/venues/slot-club?day=2026-07-17',
    );
  });
});

describe('isPublicSlug', () => {
  it.each(['slot-club', 'a1', 'central-courts-slot-club'])('accepts %s', (s) => {
    expect(isPublicSlug(s)).toBe(true);
  });
  it.each(['', 'Slot', '-a', 'a-', 'a--b', '../etc', 'a b', 'х'.repeat(3), 'a'.repeat(201)])(
    'refuses %j',
    (s) => {
      expect(isPublicSlug(s)).toBe(false);
    },
  );
});
