import {
  bellCopy,
  bookingEmail,
  formatWhen,
  type BookingFacts,
} from '@/lib/notifications/booking-copy';
import { dailyDedupeKey, dedupeKey, localDay } from '@/lib/notifications/dedupe';

/**
 * The words of a booking notification (#367): the recipient's language, the
 * club's wall clock, plain text, absolute links on SITE_URL.
 */

const FACTS: BookingFacts = {
  bookingId: 'bk_1',
  venueName: 'Sofia Padel',
  courtName: 'Корт 1',
  // 19:00–20:30 in Sofia, summer time (UTC+3).
  startTs: new Date('2026-10-09T16:00:00Z'),
  endTs: new Date('2026-10-09T17:30:00Z'),
  timezone: 'Europe/Sofia',
  cutoffHours: 24,
};

const NOW = new Date('2026-10-01T09:00:00Z');

beforeAll(() => {
  process.env.SITE_URL = 'https://playerz.bg';
});

describe('the time is the club’s wall clock', () => {
  it('19:00 in Sofia, in both languages', () => {
    expect(formatWhen('bg', FACTS.startTs, FACTS.endTs, FACTS.timezone)).toContain('19:00–20:30');
    expect(formatWhen('en', FACTS.startTs, FACTS.endTs, FACTS.timezone)).toContain('19:00–20:30');
  });

  it('across the 25 October change, a 19:00 game is still 19:00', () => {
    const winter = new Date('2026-10-27T17:00:00Z'); // UTC+2 after the change
    expect(
      formatWhen('bg', winter, new Date(winter.getTime() + 3_600_000), 'Europe/Sofia'),
    ).toContain('19:00–20:00');
  });
});

describe('the confirmation email', () => {
  it('Bulgarian: venue, court, time and zone, payment at the club, the deadline, the link', async () => {
    const { subject, text } = await bookingEmail('bg', 'confirmed', FACTS, NOW);
    expect(subject).toBe('Резервацията е потвърдена: Sofia Padel, пт, 9.10');
    expect(text).toContain('Място: Sofia Padel');
    expect(text).toContain('Корт: Корт 1');
    expect(text).toMatch(/Кога: .*19:00–20:30/);
    expect(text).toContain('Часова зона: Europe/Sofia');
    expect(text).toContain('Плащане: на място в клуба');
    // 24 hours before: Thursday 8 October, 19:00.
    expect(text).toMatch(/Можете да отмените до: .*8.*19:00/);
    expect(text).toContain('Резервацията: https://playerz.bg/me/bookings/bk_1');
    expect(text).toContain('https://playerz.bg/me/profile');
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it('English for an English recipient', async () => {
    const { subject, text } = await bookingEmail('en', 'confirmed', FACTS, NOW);
    expect(subject).toMatch(/^Booking confirmed: Sofia Padel/);
    expect(text).toContain('Payment: at the club');
    expect(text).toContain('Your booking: https://playerz.bg/me/bookings/bk_1');
  });

  it('a deadline already passed says to contact the club', async () => {
    const { text } = await bookingEmail('bg', 'reminder', FACTS, new Date('2026-10-09T13:00:00Z'));
    expect(text).toContain('срокът за отмяна изтече');
  });

  it('a venue name cannot add a header line or a line of its own', async () => {
    const evil = { ...FACTS, venueName: 'Evil\r\nBcc: x@y.bg\nКорт: fake' };
    const { subject, text } = await bookingEmail('bg', 'confirmed', evil, NOW);
    expect(subject).not.toMatch(/[\r\n]/);
    expect(text.split('\n').filter((l) => l.startsWith('Корт:'))).toHaveLength(1);
  });

  it('a club cancellation leaves out payment, deadline and the link to a dead booking', async () => {
    const { subject, text } = await bookingEmail('bg', 'cancelledByClub', FACTS, NOW);
    expect(subject).toMatch(/^Клубът отмени резервацията ви: Sofia Padel/);
    expect(text).not.toContain('Плащане');
    expect(text).not.toContain('/me/bookings/');
  });
});

describe('the bell', () => {
  it('title and body in the recipient’s language', async () => {
    expect(await bellCopy('bg', 'confirmed', FACTS)).toEqual({
      title: 'Резервацията е потвърдена',
      body: expect.stringMatching(/^Sofia Padel, Корт 1 · .*19:00–20:30$/),
    });
    expect((await bellCopy('en', 'reminder', FACTS)).title).toBe('You play in 3 hours');
  });

  it('names the other player, or "Играч" when they have no name', async () => {
    expect((await bellCopy('bg', 'playerJoined', FACTS, { name: 'Мария' })).title).toBe(
      'Мария се включи в играта',
    );
    expect((await bellCopy('bg', 'playerLeft', FACTS, { name: null })).title).toBe(
      'Играч напусна играта',
    );
  });
});

describe('dedupe keys', () => {
  it('one key per event', () => {
    expect(dedupeKey('booking', 'bk_1', 'reminder')).toBe('booking:bk_1:reminder');
    expect(() => dedupeKey('booking', 'a:b')).toThrow();
    expect(() => dedupeKey('booking', '')).toThrow();
  });

  it('the daily cap (#375) turns over at the club’s midnight, not UTC’s', () => {
    // 23:30 Sofia on 24 Oct is 20:30Z; 00:30 Sofia on 25 Oct is 21:30Z.
    expect(dailyDedupeKey('message', 'conv1', new Date('2026-10-24T20:30:00Z'))).toBe(
      'message:conv1:2026-10-24',
    );
    expect(dailyDedupeKey('message', 'conv1', new Date('2026-10-24T21:30:00Z'))).toBe(
      'message:conv1:2026-10-25',
    );
    expect(localDay(new Date('2026-10-24T21:30:00Z'), 'UTC')).toBe('2026-10-24');
  });
});
