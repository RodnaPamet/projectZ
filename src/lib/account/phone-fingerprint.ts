import { createHmac, hkdfSync } from 'node:crypto';

import { normalizePhone } from '@/lib/booking/phone';
import { DEV_FALLBACK_DATA_ENCRYPTION_KEY } from '@/lib/security/encryption-constants';

/**
 * A keyed fingerprint of a phone number (#500; owner decision 2026-10-13: one
 * number confirms one account, and it carries blocks to the next).
 *
 * `app_user.phoneHash` holds it for the number an account confirmed, under a
 * UNIQUE index, so "is this number taken?" is answered by an indexed lookup
 * and the number itself (stored encrypted, in `phone`) is never compared in
 * SQL. `no_show_carry.phoneFingerprint` holds it for a deleted account's
 * carried standing.
 *
 * ═══ KEYED, SO IT IS NOT THE NUMBER ═══
 *
 * HMAC-SHA256 of the number in E.164, under a key derived with HKDF from
 * DATA_ENCRYPTION_KEY with a label of its own, as the address fingerprint is
 * (no-show-fingerprint.ts) and distinct from it. A phone number has little
 * entropy: an unkeyed hash of one is reversed by trying every number in a
 * country. With the key held outside the database, a copy of the table cannot
 * be searched for a number.
 *
 * ═══ ROTATING THE BASE KEY ═══
 *
 * A fingerprint made under the old key never matches one made under the new:
 * after a rotation the uniqueness and the carry-over hold only among numbers
 * confirmed since. Re-fingerprinting from the encrypted `phone` column is the
 * repair (a script, when a rotation is ever planned).
 */
export const PHONE_FINGERPRINT_INFO = 'playerz/phone-fingerprint/v1';
const SALT = 'playerz/phone-fingerprint/salt';

function baseKeyMaterial(): string {
  const key = process.env.DATA_ENCRYPTION_KEY;
  if (key && key.length >= 32) return key;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATA_ENCRYPTION_KEY is required in production (phone fingerprint).');
  }
  return DEV_FALLBACK_DATA_ENCRYPTION_KEY;
}

let cached: { material: string; key: Buffer } | null = null;

function fingerprintKey(): Buffer {
  const material = baseKeyMaterial();
  if (cached?.material === material) return cached.key;
  const key = Buffer.from(hkdfSync('sha256', material, SALT, PHONE_FINGERPRINT_INFO, 32));
  cached = { material, key };
  return key;
}

/**
 * The fingerprint of a number already in E.164 (`+359888123456`): 64 hex
 * characters. Throws on anything else: a fingerprint of an un-normalised
 * number would silently never match.
 */
export function phoneFingerprint(e164: string): string {
  if (normalizePhone(e164) !== e164) {
    throw new Error('phoneFingerprint: the number must be in E.164 (normalizePhone first).');
  }
  return createHmac('sha256', fingerprintKey()).update(e164, 'utf8').digest('hex');
}

/** `+359 88 *** **56`: enough for its owner to recognise, not enough to dial. */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/^\+/, '');
  if (digits.length < 7) return '+' + '*'.repeat(digits.length);
  // The country code and a little more: three to five digits, by length.
  const head = digits.slice(0, Math.min(5, Math.max(3, digits.length - 7)));
  const tail = digits.slice(-2);
  const hidden = digits.length - head.length - tail.length;
  return `+${head}${'*'.repeat(hidden)}${tail}`;
}
