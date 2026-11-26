import { REFUSAL_REASONS, type ReviewRefusal } from '@/lib/moderation/refusal';
import { reviewRefusedBellCopy, reviewRefusedEmail } from '@/lib/notifications/review-copy';

/**
 * The notice about a refused review (#714): the statement of reasons the
 * Digital Services Act (Art. 17) and the terms (section 10) promise. What was
 * done, why, whether automatically, and how to object.
 */

// notification-outbox's limits; importing it would open the database pool.
const NOTIFICATION_TITLE_MAX = 80;
const NOTIFICATION_BODY_MAX = 200;
const EMAIL_SUBJECT_MAX = 150;

beforeAll(() => {
  process.env.SITE_URL = 'https://playerz.bg';
});

const AUTO: ReviewRefusal = {
  action: 'NOT_PUBLISHED',
  reason: 'self_harm_instructions',
  automated: true,
  decidedAt: new Date('2026-11-26T10:00:00Z'),
};
const BY_HAND: ReviewRefusal = {
  action: 'REMOVED',
  reason: 'harassment',
  automated: false,
  decidedAt: new Date('2026-11-26T11:00:00Z'),
};
const VENUE = { kind: 'venue', venue: 'Тенис клуб Сердика' } as const;
const COACH = { kind: 'coach', coach: 'Петя Иванова' } as const;

describe('the bell', () => {
  it('an automatic refusal, in Bulgarian', async () => {
    const c = await reviewRefusedBellCopy('bg', AUTO, VENUE);
    expect(c.title).toBe('Отзивът ви не е публикуван');
    expect(c.body).toBe(
      'Отзив за Тенис клуб Сердика. Причина: указания за самонараняване. Решено автоматично. ' +
        'Не сте съгласни? Пишете на privacy@playerz.bg.',
    );
  });

  it('a moderator removing a coach review, in English', async () => {
    const c = await reviewRefusedBellCopy('en', BY_HAND, COACH);
    expect(c.title).toBe('Your review was removed');
    expect(c.body).toContain('coach Петя Иванова');
    expect(c.body).toContain('insults or harassment of other people');
    expect(c.body).toContain('Decided by a moderator.');
    expect(c.body).toContain('privacy@playerz.bg');
  });

  it('a coach whose account is gone is still named as a coach', async () => {
    const c = await reviewRefusedBellCopy('bg', AUTO, { kind: 'coach', coach: null });
    expect(c.body).toMatch(/^Отзив за треньор\. /);
  });

  it.each(REFUSAL_REASONS.map((r) => [r]))('fits the bell with %s and a long name', async (r) => {
    const long = { kind: 'venue', venue: 'Б'.repeat(60) } as const;
    for (const locale of ['bg', 'en']) {
      const c = await reviewRefusedBellCopy(locale, { ...BY_HAND, reason: r }, long);
      expect(c.title.length).toBeLessThanOrEqual(NOTIFICATION_TITLE_MAX);
      expect(c.body.length).toBeLessThanOrEqual(NOTIFICATION_BODY_MAX);
      expect(c.body).not.toContain('{');
    }
  });

  it('a name cannot add a line', async () => {
    const c = await reviewRefusedBellCopy('bg', AUTO, { kind: 'venue', venue: 'A\nB' });
    expect(c.body).not.toContain('\n');
  });
});

describe('the email: the whole statement of reasons', () => {
  it('automatic: what, why with the rule, who, and every way to object', async () => {
    const e = await reviewRefusedEmail('bg', AUTO, VENUE);
    expect(e.subject).toBe('Отзивът ви не е публикуван');
    expect(e.text).toContain('Отзивът ви за Тенис клуб Сердика не е публикуван.');
    expect(e.text).toContain('Защо: указания за самонараняване.');
    expect(e.text).toContain('https://playerz.bg/terms');
    expect(e.text).toContain('автоматично, от модел с изкуствен интелект на Anthropic');
    expect(e.text).toContain('privacy@playerz.bg');
    expect(e.text).toContain('поискайте човек да прегледа решението отново');
    expect(e.text).toContain('(КРС)');
    expect(e.text).toContain('(КЗП)');
    expect(e.text).toContain('към съда');
    expect(e.text).toContain('https://playerz.bg/me/bookings?tab=past');
    expect(e.text).not.toMatch(/[ыэё]|ь(?!о)/);
    expect(e.subject.length).toBeLessThanOrEqual(EMAIL_SUBJECT_MAX);
  });

  it('by a moderator, removed, in English: never says it was automatic', async () => {
    const e = await reviewRefusedEmail('en', BY_HAND, COACH);
    expect(e.subject).toBe('Your review was removed');
    expect(e.text).toContain('Your review of coach Петя Иванова was removed');
    expect(e.text).toContain('by a moderator');
    expect(e.text).not.toContain('automatically');
    expect(e.text).toContain('courts');
  });

  it('never carries a score', async () => {
    const e = await reviewRefusedEmail('bg', AUTO, VENUE);
    expect(e.text).not.toMatch(/\d+(\.\d+)?\s*%|0\.\d/);
  });
});
