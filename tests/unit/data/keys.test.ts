import { clubKeys, KEYS, keysUnder, V1 } from '@/lib/data/keys';

describe('KEYS', () => {
  it('one read is one key, whatever order the params were written in', () => {
    const a = KEYS.venues({ q: 'padel', city: 'Sofia', indoor: true })(0, null);
    const b = KEYS.venues({ indoor: true, city: 'Sofia', q: 'padel' })(0, null);
    expect(a).toBe(b);
    expect(a).toBe('/api/v1/venues?city=Sofia&indoor=true&q=padel');
  });

  it('drops empty params, so "no filter" has one spelling', () => {
    expect(KEYS.venues({ q: '', city: undefined })(0, null)).toBe('/api/v1/venues');
  });

  it('a cursor list follows nextCursor, and ends on null', () => {
    const getKey = KEYS.moderationCases({ reason: 'weekly queue review' });
    expect(getKey(0, null)).toBe('/api/v1/platform/moderation/cases?reason=weekly+queue+review');
    expect(getKey(1, { items: [], nextCursor: 'c_1' })).toBe(
      '/api/v1/platform/moderation/cases?cursor=c_1&reason=weekly+queue+review',
    );
    expect(getKey(2, { items: [], nextCursor: null })).toBeNull();
  });

  it('the server-side reason is IN the key: a different reason is a different read', () => {
    expect(KEYS.moderationCases({ reason: 'a reason here!' })(0, null)).not.toBe(
      KEYS.moderationCases({ reason: 'another reason' })(0, null),
    );
  });

  it('encodes path segments', () => {
    expect(KEYS.me('a/b')).toBe('/api/v1/t/a%2Fb/me');
    expect(V1.resolveCase('c 1')).toBe('/api/v1/platform/moderation/cases/c%201/resolve');
  });

  it('builds the write URLs', () => {
    expect(V1.review('club', 'b1')).toBe('/api/v1/t/club/bookings/b1/review');
    expect(V1.cancelBooking('club', 'b1')).toBe('/api/v1/t/club/bookings/b1/cancel');
    expect(V1.createBooking('club')).toBe('/api/v1/t/club/bookings');
    expect(KEYS.myBookings('club')(0, null)).toBe('/api/v1/t/club/bookings');
  });
});

describe('matchers', () => {
  it('select plain keys by prefix, and nothing that is not a string', () => {
    const club = clubKeys('club');
    expect(club(KEYS.me('club'))).toBe(true);
    expect(club(KEYS.me('other'))).toBe(false);
    expect(club(undefined)).toBe(false);
    expect(keysUnder('/api/v1/venues')('/api/v1/venues?q=a')).toBe(true);
  });
});
