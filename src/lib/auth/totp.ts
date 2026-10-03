import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) and the recovery-code format, with no database and no clock
 * of its own — every function takes `now` or a step explicitly, so the whole
 * second factor is testable against the RFC's published vectors.
 *
 * ═══ WHY HAND-WRITTEN, AND WHY THAT IS NOT A RISK HERE ═══
 *
 * Nothing in the dependency tree implements TOTP. The candidates (`otplib`,
 * `speakeasy`, `otpauth`) are either unmaintained or bring a plugin system for
 * a 40-line algorithm. The algorithm IS the RFC: one HMAC-SHA1 over a counter,
 * dynamic truncation, modulo 10^6. What makes an implementation wrong is
 * checkable — the RFC 6238 Appendix B vectors and the RFC 4226 Appendix D
 * vectors are both in tests/unit/auth/totp.test.ts, and a wrong truncation or
 * counter encoding fails them.
 *
 * The parts that are security decisions rather than arithmetic are stated
 * where they are made:
 *
 *   - a code is compared in constant time, and EVERY candidate step is
 *     compared, so the response time does not say which step nearly matched;
 *   - the verifier returns the matched STEP, not a boolean, because the
 *     caller must refuse a step it has already accepted (replay inside the
 *     window) — see `mfaLastUsedStep` in src/lib/auth/mfa.ts;
 *   - the window is ±1 step (±30 s), the RFC's recommended drift allowance.
 *     Wider windows multiply the brute-force odds for no usability gain on a
 *     phone with network time.
 */

/** RFC 6238 defaults. Every authenticator app assumes these when told nothing. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of now that are accepted: clock drift, and a code typed as it rolled over. */
export const TOTP_DRIFT_STEPS = 1;
/** 160 bits: the HMAC-SHA1 block the RFC recommends for the shared secret. */
export const TOTP_SECRET_BYTES = 20;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding — the form authenticator apps accept. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error('base32Decode: invalid character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh shared secret, base32 — what is encrypted into `User.mfaSecret`. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** The 30-second step `now` falls in. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** HOTP (RFC 4226) for one counter value, as a zero-padded decimal string. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  // A JS number holds a step exactly up to 2^53, which is ~8.5e15 years of
  // 30-second steps; writing it as two 32-bit halves avoids BigInt in the hot
  // path without losing anything.
  msg.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The code an authenticator shows at `nowMs`. Used by tests and nothing else. */
export function totpAt(secretBase32: string, nowMs: number): string {
  return hotp(base32Decode(secretBase32), totpStep(nowMs));
}

/** Whether `code` is even shaped like a TOTP code — six digits, spaces allowed. */
export function looksLikeTotp(code: string): boolean {
  return /^\d{6}$/.test(code.replace(/\s/g, ''));
}

/**
 * The step `code` is valid for, within ±TOTP_DRIFT_STEPS of now — or null.
 *
 * Every candidate is computed and compared, and the comparison is
 * `timingSafeEqual` over equal-length buffers, so neither "how many steps were
 * tried" nor "how many leading digits matched" leaks through timing. The
 * caller still has to refuse a step it has already accepted.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number): number | null {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;

  const secret = base32Decode(secretBase32);
  const givenBuf = Buffer.from(given, 'utf8');
  const now = totpStep(nowMs);

  let matched: number | null = null;
  for (let d = -TOTP_DRIFT_STEPS; d <= TOTP_DRIFT_STEPS; d++) {
    const step = now + d;
    const expected = Buffer.from(hotp(secret, step), 'utf8');
    // No early return: the loop runs the same number of times whatever matches.
    if (timingSafeEqual(expected, givenBuf) && (matched === null || step > matched)) {
      matched = step;
    }
  }
  return matched;
}

/**
 * The `otpauth://` URI an authenticator app imports — as a link on a phone, or
 * typed in by hand from the secret it carries.
 *
 * The label is `issuer:account` and the issuer is repeated as a parameter,
 * which is what Google Authenticator, 1Password and iOS Passwords all key on
 * to show "playerz.bg" rather than an anonymous row.
 */
export function otpauthUri(secretBase32: string, account: string, issuer = 'playerz.bg'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ─── Recovery codes ─────────────────────────────────────────────────────

/** How many are issued at enrolment, and at every regeneration. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * 16 base32 characters = 80 bits each, shown as four groups of four.
 *
 * The length is what lets the stored form be a plain SHA-256: a code with 80
 * bits of entropy cannot be brute-forced from its hash, so a leaked
 * `mfa_recovery_code` table gives nothing away, and no server key is needed —
 * which means rotating DATA_ENCRYPTION_KEY cannot silently invalidate every
 * recovery code in the database the way a keyed hash would.
 */
const RECOVERY_CODE_CHARS = 16;

export function newRecoveryCode(): string {
  const raw = base32Encode(randomBytes(10)).slice(0, RECOVERY_CODE_CHARS);
  return raw.match(/.{4}/g)!.join('-');
}

/** Case, spaces and hyphens do not matter: people copy these from paper. */
export function normaliseRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export function looksLikeRecoveryCode(code: string): boolean {
  return /^[A-Z2-7]{16}$/.test(normaliseRecoveryCode(code));
}

/**
 * The stored form. Salted with the user id so the same code (astronomically
 * unlikely as that is) hashes differently per account, and so a hash copied
 * onto another account's row matches nothing.
 */
export function hashRecoveryCode(userId: string, code: string): string {
  return createHash('sha256')
    .update(`playerz-mfa-recovery-v1:${userId}:${normaliseRecoveryCode(code)}`, 'utf8')
    .digest('hex');
}
