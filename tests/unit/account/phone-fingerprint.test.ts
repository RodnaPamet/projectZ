import { noShowFingerprint } from '@/lib/account/no-show-fingerprint';
import { maskPhone, phoneFingerprint } from '@/lib/account/phone-fingerprint';

/**
 * The keyed fingerprint of a phone number (#500): what "is this number taken"
 * and the block carry-over are asked of, so the number is never compared.
 */
describe('phoneFingerprint', () => {
  it('is 64 hex characters, the same for the same number, different for another', () => {
    const a = phoneFingerprint('+359888123456');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(phoneFingerprint('+359888123456')).toBe(a);
    expect(phoneFingerprint('+359888123457')).not.toBe(a);
  });

  it('takes only E.164: an un-normalised number would silently never match', () => {
    for (const raw of ['0888123456', '+359 888 123 456', '359888123456', '', 'abc'])
      expect(() => phoneFingerprint(raw)).toThrow(/E\.164/);
  });

  it('is keyed, and with a key of its own', () => {
    const before = process.env.DATA_ENCRYPTION_KEY;
    try {
      process.env.DATA_ENCRYPTION_KEY = 'a'.repeat(48);
      const underA = phoneFingerprint('+359888123456');
      process.env.DATA_ENCRYPTION_KEY = 'b'.repeat(48);
      expect(phoneFingerprint('+359888123456')).not.toBe(underA);
      // Not the address fingerprint's key: the same text gives another value.
      expect(noShowFingerprint('+359888123456')).not.toBe(phoneFingerprint('+359888123456'));
    } finally {
      if (before === undefined) delete process.env.DATA_ENCRYPTION_KEY;
      else process.env.DATA_ENCRYPTION_KEY = before;
    }
  });
});

describe('maskPhone', () => {
  it('keeps the start and the last two digits, and hides the middle', () => {
    expect(maskPhone('+359888123456')).toBe('+35988*****56');
    expect(maskPhone('+447911123456')).toBe('+44791*****56');
    expect(maskPhone('+12025550123')).toBe('+1202*****23');
  });

  it('never shows a whole number, however short', () => {
    for (const n of ['+35912345', '+3721234567', '+359888123456']) {
      const masked = maskPhone(n);
      expect(masked).toContain('*');
      expect(masked.length).toBe(n.length);
      expect(masked.replace(/\D/g, '').length).toBeLessThanOrEqual(n.length - 4);
    }
  });
});
