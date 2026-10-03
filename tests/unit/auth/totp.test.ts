/**
 * @jest-environment node
 */
import {
  base32Decode,
  base32Encode,
  hashRecoveryCode,
  hotp,
  looksLikeRecoveryCode,
  newRecoveryCode,
  newTotpSecret,
  normaliseRecoveryCode,
  otpauthUri,
  totpAt,
  totpStep,
  verifyTotp,
} from '@/lib/auth/totp';
import { isStepUpFresh, stepUpExpiresAt } from '@/lib/auth/step-up';
import { MFA_STEP_UP_WINDOW_SECONDS } from '@/lib/platform/capabilities';

/**
 * THE SECOND FACTOR'S ARITHMETIC, AGAINST THE RFCs' OWN VECTORS (#262).
 *
 * TOTP is hand-written here (src/lib/auth/totp.ts says why), so what makes it
 * trustworthy is that it reproduces the published test vectors exactly. A
 * wrong truncation offset, a little-endian counter or an off-by-one step
 * fails these — they are the RFCs' appendices, not values this code produced.
 */

// RFC 4226 Appendix D / RFC 6238 Appendix B: the ASCII secret "12345678901234567890".
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('base32 (RFC 4648)', () => {
  it('encodes the RFC secret as authenticator apps expect', () => {
    expect(base32Encode(RFC_SECRET)).toBe(RFC_SECRET_B32);
    expect(base32Decode(RFC_SECRET_B32).equals(RFC_SECRET)).toBe(true);
  });

  it('round-trips random secrets, and ignores case, spaces and padding', () => {
    for (let i = 0; i < 20; i++) {
      const s = newTotpSecret();
      expect(s).toMatch(/^[A-Z2-7]{32}$/); // 160 bits
      expect(base32Encode(base32Decode(s))).toBe(s);
      expect(base32Decode(s.toLowerCase().replace(/(.{4})/g, '$1 ')).equals(base32Decode(s))).toBe(
        true,
      );
    }
  });

  it('refuses characters outside the alphabet rather than guessing', () => {
    expect(() => base32Decode('ABC1')).toThrow();
  });
});

describe('HOTP (RFC 4226 Appendix D)', () => {
  it.each([
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ])('counter %i → %s', (counter, code) => {
    expect(hotp(RFC_SECRET, counter)).toBe(code);
  });
});

describe('TOTP (RFC 6238 Appendix B, SHA-1, 8 digits)', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    // Past 2^32 seconds / 30: the counter's HIGH word is non-zero here, which
    // is what a 32-bit-only counter encoding gets wrong.
    [20000000000, '65353130'],
  ])('T=%i → %s', (seconds, code) => {
    expect(hotp(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(code);
  });
});

describe('verifyTotp', () => {
  const secret = newTotpSecret();
  const now = Date.UTC(2026, 9, 3, 12, 0, 15);

  it('accepts the current code and returns its STEP, not a boolean', () => {
    expect(verifyTotp(secret, totpAt(secret, now), now)).toBe(totpStep(now));
  });

  it('accepts one step either side — drift and a code typed as it rolled over', () => {
    expect(verifyTotp(secret, totpAt(secret, now - 30_000), now)).toBe(totpStep(now) - 1);
    expect(verifyTotp(secret, totpAt(secret, now + 30_000), now)).toBe(totpStep(now) + 1);
  });

  it('refuses two steps away — the window is ±30 s, not wider', () => {
    // Codes from two steps away could coincide with a window code by chance
    // (1 in 10^6); skip the vanishingly rare collision rather than flake.
    const old = totpAt(secret, now - 60_000);
    const near = [-1, 0, 1].map((d) => totpAt(secret, now + d * 30_000));
    if (!near.includes(old)) expect(verifyTotp(secret, old, now)).toBeNull();
  });

  it('refuses anything not shaped like six digits, before any HMAC', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5x']) {
      expect(verifyTotp(secret, bad, now)).toBeNull();
    }
  });

  it('tolerates spaces people type between the halves', () => {
    const c = totpAt(secret, now);
    expect(verifyTotp(secret, `${c.slice(0, 3)} ${c.slice(3)}`, now)).toBe(totpStep(now));
  });

  it("refuses another secret's code", () => {
    const other = newTotpSecret();
    const c = totpAt(other, now);
    const mine = [-1, 0, 1].map((d) => totpAt(secret, now + d * 30_000));
    if (!mine.includes(c)) expect(verifyTotp(secret, c, now)).toBeNull();
  });
});

describe('otpauth URI', () => {
  it('names the issuer twice, as authenticator apps key on it', () => {
    const uri = otpauthUri(RFC_SECRET_B32, 'mod@playerz.bg');
    expect(uri.startsWith('otpauth://totp/playerz.bg:mod%40playerz.bg?')).toBe(true);
    const params = new URL(uri.replace('otpauth://', 'https://')).searchParams;
    expect(params.get('secret')).toBe(RFC_SECRET_B32);
    expect(params.get('issuer')).toBe('playerz.bg');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
    expect(params.get('algorithm')).toBe('SHA1');
  });
});

describe('recovery codes', () => {
  it('are 80 bits, grouped in fours, and all different', () => {
    const codes = Array.from({ length: 50 }, newRecoveryCode);
    for (const c of codes) {
      expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
      expect(looksLikeRecoveryCode(c)).toBe(true);
    }
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('match however they are typed back — case, spaces, hyphens', () => {
    const c = newRecoveryCode();
    const typed = ` ${c.toLowerCase().replace(/-/g, ' ')} `;
    expect(normaliseRecoveryCode(typed)).toBe(c.replace(/-/g, ''));
    expect(hashRecoveryCode('u1', typed)).toBe(hashRecoveryCode('u1', c));
  });

  it('hash differently per account, so a hash copied to another row matches nothing', () => {
    const c = newRecoveryCode();
    expect(hashRecoveryCode('u1', c)).not.toBe(hashRecoveryCode('u2', c));
    expect(hashRecoveryCode('u1', c)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('step-up freshness (the window boundary, without a database)', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  const ago = (s: number) => new Date(now.getTime() - s * 1000);

  it('counts inside the window and not at or after its end', () => {
    expect(isStepUpFresh(ago(0), now)).toBe(true);
    expect(isStepUpFresh(ago(MFA_STEP_UP_WINDOW_SECONDS - 1), now)).toBe(true);
    // Exactly at the end is expired: the direction that grants less.
    expect(isStepUpFresh(ago(MFA_STEP_UP_WINDOW_SECONDS), now)).toBe(false);
    expect(isStepUpFresh(ago(MFA_STEP_UP_WINDOW_SECONDS + 3600), now)).toBe(false);
  });

  it('never counts a session that has not stepped up', () => {
    expect(isStepUpFresh(null, now)).toBe(false);
  });

  it('tolerates a little instance clock skew, and no more', () => {
    expect(isStepUpFresh(ago(-30), now)).toBe(true);
    expect(isStepUpFresh(ago(-120), now)).toBe(false);
  });

  it('reports when the window closes', () => {
    expect(stepUpExpiresAt(ago(0))!.getTime() - now.getTime()).toBe(
      MFA_STEP_UP_WINDOW_SECONDS * 1000,
    );
    expect(stepUpExpiresAt(null)).toBeNull();
  });
});
