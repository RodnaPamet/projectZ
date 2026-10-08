import { createHmac, hkdfSync } from 'node:crypto';

import { DEV_FALLBACK_DATA_ENCRYPTION_KEY } from '@/lib/security/encryption-constants';

/**
 * A keyed fingerprint of an email address (#370 review; owner decision
 * 2026-10-08, "carry the no-show block over"): what a deleted account keeps,
 * while it has a no-show standing at a club, so that an account made later
 * with the same address takes that standing over (src/app-layer/usecases/
 * no-show-carry.ts).
 *
 * ═══ KEYED, SO IT IS NOT THE ADDRESS ═══
 *
 * HMAC-SHA256 of the address as sign-in compares it (trimmed, lower case),
 * under a key derived with HKDF from DATA_ENCRYPTION_KEY with a label of its
 * own. No new secret: the base key the field encryption already needs. Without
 * the key a fingerprint names nobody, and a database copy cannot be searched
 * for an address; with it, a fingerprint can only be compared with an address
 * somebody gives.
 *
 * ═══ ROTATING THE BASE KEY ENDS THE CARRY-OVER ═══
 *
 * A fingerprint made under the old key never matches one made under the new.
 * After DATA_ENCRYPTION_KEY is rotated, no deleted account's standing passes
 * to a new account; the rows still lapse on their own within 90 days. That is
 * the accepted cost of not adding a key nobody would remember to rotate.
 */
export const NO_SHOW_FINGERPRINT_INFO = 'playerz/no-show-fingerprint/v1';
const SALT = 'playerz/no-show-fingerprint/salt';

function baseKeyMaterial(): string {
  const key = process.env.DATA_ENCRYPTION_KEY;
  if (key && key.length >= 32) return key;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATA_ENCRYPTION_KEY is required in production (no-show fingerprint).');
  }
  return DEV_FALLBACK_DATA_ENCRYPTION_KEY;
}

let cached: { material: string; key: Buffer } | null = null;

function fingerprintKey(): Buffer {
  const material = baseKeyMaterial();
  if (cached?.material === material) return cached.key;
  const key = Buffer.from(hkdfSync('sha256', material, SALT, NO_SHOW_FINGERPRINT_INFO, 32));
  cached = { material, key };
  return key;
}

/** The address as sign-in compares it (src/auth.ts): trimmed, lower case. */
export function normaliseAddress(email: string): string {
  return email.trim().toLowerCase();
}

/** The fingerprint of an address: 64 hex characters, the same for any casing of it. */
export function noShowFingerprint(email: string): string {
  return createHmac('sha256', fingerprintKey())
    .update(normaliseAddress(email), 'utf8')
    .digest('hex');
}
