import { phoneClaim, phoneStillToAsk } from '@/lib/auth/phone-ask';

/**
 * Where an account stands on the phone number (#500), as its session token
 * carries it for the one-time ask.
 */
describe('phoneClaim', () => {
  const at = new Date('2026-10-20T09:00:00Z');

  it('a confirmed number is ok, whatever the account', () => {
    for (const accountKind of ['PLAYER', 'COACH', 'CLUB', null])
      expect(phoneClaim({ accountKind, phoneVerifiedAt: at })).toBe('ok');
  });

  it('a player or a coach with none is asked', () => {
    expect(phoneClaim({ accountKind: 'PLAYER', phoneVerifiedAt: null })).toBe('ask');
    expect(phoneClaim({ accountKind: 'COACH', phoneVerifiedAt: null })).toBe('ask');
  });

  it('a club’s account is not, nor one that has not chosen its kind yet', () => {
    expect(phoneClaim({ accountKind: 'CLUB', phoneVerifiedAt: null })).toBe('na');
    expect(phoneClaim({ accountKind: null, phoneVerifiedAt: null })).toBe('na');
  });
});

describe('phoneStillToAsk', () => {
  it('only ok and na are settled; a missing or unknown claim is still to ask', () => {
    expect(phoneStillToAsk('ok')).toBe(false);
    expect(phoneStillToAsk('na')).toBe(false);
    for (const claim of ['ask', undefined, null, '', 'OK', 7])
      expect(phoneStillToAsk(claim)).toBe(true);
  });
});
