import {
  PHONE_CHALLENGE_TTL_MS,
  readPhoneChallenge,
  signPhoneChallenge,
} from '@/lib/account/phone-challenge';

/**
 * The phone step's challenge (#500): what ties a code that was sent to the
 * account that asked for it and the number it went to.
 */
const NOW = Date.UTC(2026, 9, 20, 9, 0, 0);
const BASE = {
  userId: 'usr_ana',
  fingerprint: 'f'.repeat(64),
  ref: 'PIN123',
  expiresAt: NOW + PHONE_CHALLENGE_TTL_MS,
};

describe('the phone challenge', () => {
  it('round-trips what it was made with', () => {
    const token = signPhoneChallenge(BASE);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(readPhoneChallenge(token, NOW)).toEqual(BASE);
  });

  it('is good for ten minutes, and not a millisecond after', () => {
    const token = signPhoneChallenge(BASE);
    expect(PHONE_CHALLENGE_TTL_MS).toBe(10 * 60_000);
    expect(readPhoneChallenge(token, BASE.expiresAt - 1)).not.toBeNull();
    expect(readPhoneChallenge(token, BASE.expiresAt)).toBeNull();
    expect(readPhoneChallenge(token, BASE.expiresAt + 1)).toBeNull();
  });

  it('any change to the payload or the tag makes it nobody’s', () => {
    const token = signPhoneChallenge(BASE);
    const [payload, tag] = token.split('.') as [string, string];

    // The same shape, with another account, number or pin, under the old tag.
    for (const change of [
      { userId: 'usr_boris' },
      { fingerprint: 'e'.repeat(64) },
      { ref: 'PIN999' },
    ]) {
      const other = signPhoneChallenge({ ...BASE, ...change }).split('.')[0]!;
      expect(readPhoneChallenge(`${other}.${tag}`, NOW)).toBeNull();
    }
    // A longer life, under the old tag.
    const longer = signPhoneChallenge({ ...BASE, expiresAt: BASE.expiresAt + 86_400_000 });
    expect(readPhoneChallenge(`${longer.split('.')[0]!}.${tag}`, NOW)).toBeNull();
    // A tag of the wrong length, or none.
    expect(readPhoneChallenge(`${payload}.${tag.slice(0, -2)}`, NOW)).toBeNull();
    expect(readPhoneChallenge(`${payload}.`, NOW)).toBeNull();
    expect(readPhoneChallenge(payload, NOW)).toBeNull();
  });

  it('anything that is not one of ours reads as nothing', () => {
    for (const junk of [undefined, null, 7, {}, '', '.', 'a.b.c', 'not a token', 'x'.repeat(3000)])
      expect(readPhoneChallenge(junk, NOW)).toBeNull();
  });

  it('a correctly signed payload of the wrong shape reads as nothing', () => {
    // Signed by us, but not a challenge: every field is checked, not only the tag.
    const odd = signPhoneChallenge({ ...BASE, expiresAt: 'soon' as unknown as number });
    expect(readPhoneChallenge(odd, NOW)).toBeNull();
  });

  it('is keyed: one made under another base key is not ours', () => {
    const before = process.env.DATA_ENCRYPTION_KEY;
    try {
      process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(48);
      const underA = signPhoneChallenge(BASE);
      process.env.DATA_ENCRYPTION_KEY = 'b'.repeat(48);
      expect(readPhoneChallenge(underA, NOW)).toBeNull();
      expect(readPhoneChallenge(signPhoneChallenge(BASE), NOW)).toEqual(BASE);
    } finally {
      if (before === undefined) delete process.env.DATA_ENCRYPTION_KEY;
      else process.env.DATA_ENCRYPTION_KEY = before;
    }
  });

  it('does not carry the number', () => {
    const payload = signPhoneChallenge(BASE).split('.')[0]!;
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    expect(Object.keys(JSON.parse(json) as object).sort()).toEqual(['f', 'r', 'u', 'x']);
  });
});
