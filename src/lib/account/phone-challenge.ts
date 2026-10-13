import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { DEV_FALLBACK_DATA_ENCRYPTION_KEY } from '@/lib/security/encryption-constants';

/**
 * The phone step's challenge (#500): what ties the code that was sent to the
 * account that asked for it and the number it went to.
 *
 * ═══ WHY IT EXISTS ═══
 *
 * The SMS provider checks a code by the id of the code it sent (`ref`), and
 * knows nothing of our accounts. If `confirm` took a number, a code and a
 * `ref` at face value, a person could have a code sent to THEIR phone, then
 * confirm with it while naming somebody else's number, and hold that number.
 *
 * So `start` hands the client a challenge, and `confirm` gives it back:
 *
 *   payload   the account, the keyed fingerprint of the number (never the
 *             number), the provider's `ref`, and when it stops being good
 *   tag       HMAC-SHA256 of the payload, under a key of this module's own
 *
 * `confirm` accepts it only if the tag matches, it has not expired, it was
 * made for THIS account, and the number sent with it has THAT fingerprint.
 * Nothing is stored between the two requests: there is no "pending number"
 * row to expire, race or clean up.
 *
 * It is not a secret and not a credential: whoever holds it still needs the
 * code from the SMS. The `ref` inside is readable, and is useless without it.
 *
 * The key is HKDF-derived from DATA_ENCRYPTION_KEY with a label of its own,
 * as the fingerprints are. Rotating the base key voids the challenges in
 * flight, which costs somebody one more SMS.
 */
export const PHONE_CHALLENGE_INFO = 'playerz/phone-challenge/v1';
const SALT = 'playerz/phone-challenge/salt';

/** How long a challenge is good for: as long as the code it belongs to. */
export const PHONE_CHALLENGE_TTL_MS = 10 * 60_000;

export interface PhoneChallenge {
  userId: string;
  /** `phoneFingerprint` of the number the code went to. */
  fingerprint: string;
  /** The provider's id for the code it sent. */
  ref: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

function baseKeyMaterial(): string {
  const key = process.env.DATA_ENCRYPTION_KEY;
  if (key && key.length >= 32) return key;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATA_ENCRYPTION_KEY is required in production (phone challenge).');
  }
  return DEV_FALLBACK_DATA_ENCRYPTION_KEY;
}

let cached: { material: string; key: Buffer } | null = null;

function challengeKey(): Buffer {
  const material = baseKeyMaterial();
  if (cached?.material === material) return cached.key;
  const key = Buffer.from(hkdfSync('sha256', material, SALT, PHONE_CHALLENGE_INFO, 32));
  cached = { material, key };
  return key;
}

const tagOf = (payload: string) =>
  createHmac('sha256', challengeKey()).update(payload, 'utf8').digest();

/** `<payload>.<tag>`, both base64url. */
export function signPhoneChallenge(challenge: PhoneChallenge): string {
  const payload = Buffer.from(
    JSON.stringify({
      u: challenge.userId,
      f: challenge.fingerprint,
      r: challenge.ref,
      x: challenge.expiresAt,
    }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${tagOf(payload).toString('base64url')}`;
}

/**
 * The challenge inside `token`, or null: not ours, altered, malformed or
 * expired. The caller still checks it against the account and the number.
 */
export function readPhoneChallenge(
  token: unknown,
  now: number = Date.now(),
): PhoneChallenge | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const payload = token.slice(0, dot);

  let given: Buffer;
  try {
    given = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch {
    return null;
  }
  const expected = tagOf(payload);
  // Length first: timingSafeEqual throws on a mismatch.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { u, f, r, x } = parsed as Record<string, unknown>;
  if (
    typeof u !== 'string' ||
    typeof f !== 'string' ||
    typeof r !== 'string' ||
    typeof x !== 'number'
  ) {
    return null;
  }
  if (x <= now) return null;
  return { userId: u, fingerprint: f, ref: r, expiresAt: x };
}
