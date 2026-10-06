import {
  createSeriesBodySchema,
  deskCustomerSchema,
  isoDateSchema,
  repeatSchema,
} from '@/app-layer/schemas/desk';
import { normalizePhone } from '@/lib/booking/phone';

/**
 * The desk's customer (#364): a phone in one canonical form, so "match by
 * phone" finds the same person however the desk typed them.
 */
describe('normalizePhone', () => {
  it.each([
    ['0888 123 456', '+359888123456'],
    ['0888-123-456', '+359888123456'],
    ['+359 88 812 3456', '+359888123456'],
    ['00359888123456', '+359888123456'],
    ['359888123456', '+359888123456'],
    ['(02) 981 23 45', '+35929812345'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('%s → %s', (raw, e164) => {
    expect(normalizePhone(raw)).toBe(e164);
  });

  it.each(['', '   ', 'call me', '888123456', '+12', '0888 123 456 ext 2', '+1234567890123456'])(
    'refuses %p',
    (raw) => {
      expect(normalizePhone(raw)).toBeNull();
    },
  );
});

describe('the desk schemas', () => {
  it('normalises the phone and tidies the name', () => {
    expect(deskCustomerSchema.parse({ name: '  Иван   Петров ', phone: '0888 123 456' })).toEqual({
      name: 'Иван Петров',
      phone: '+359888123456',
    });
  });

  it('refuses unknown properties, so a typo cannot book at the quote', () => {
    expect(
      deskCustomerSchema.safeParse({ name: 'A', phone: '0888123456', mail: 'x' }).success,
    ).toBe(false);
  });

  it('a repeat is weeks OR until, never both or neither', () => {
    expect(repeatSchema.safeParse({ weeks: 4 }).success).toBe(true);
    expect(repeatSchema.safeParse({ until: '2026-12-01' }).success).toBe(true);
    expect(repeatSchema.safeParse({}).success).toBe(false);
    expect(repeatSchema.safeParse({ weeks: 4, until: '2026-12-01' }).success).toBe(false);
  });

  it('a date is a real calendar day', () => {
    expect(isoDateSchema.safeParse('2028-02-29').success).toBe(true);
    expect(isoDateSchema.safeParse('2026-02-29').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-2-1').success).toBe(false);
  });

  it('a series body needs its repeat', () => {
    const base = {
      resourceId: 'r1',
      date: '2026-10-20',
      startTime: '19:00',
      durationMinutes: 60,
      customer: { name: 'A', phone: '0888123456' },
    };
    expect(createSeriesBodySchema.safeParse(base).success).toBe(false);
    expect(createSeriesBodySchema.safeParse({ ...base, repeat: { weeks: 2 } }).success).toBe(true);
    expect(
      createSeriesBodySchema.safeParse({ ...base, repeat: { weeks: 2 }, startTime: '24:00' })
        .success,
    ).toBe(false);
  });
});
