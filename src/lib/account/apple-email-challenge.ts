import { createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto';

import { DEV_FALLBACK_DATA_ENCRYPTION_KEY } from '@/lib/security/encryption-constants';

/**
 * The hidden-address step of Sign in with Apple (#442; owner decision
 * 2026-10-14): a person whose Apple address is a relay confirms a real one
 * with a code before an account is found or made.
 *
 * ═══ TWO TOKENS, NOTHING STORED ═══
 *
 *   ticket     handed out by the Apple sign-in that stopped: WHICH Apple ID
 *              (its `sub`), the name the app sent, the language. Good for 30
 *              minutes. It proves the Apple sign-in happened, nothing more.
 *   challenge  handed out when the code is sent: the ticket's facts plus the
 *              address and a keyed tag of the code. Good for 10 minutes.
 *
 * Each is `<payload>.<tag>`, both base64url, the tag an HMAC-SHA256 under a key
 * of this module's own (HKDF from DATA_ENCRYPTION_KEY, as the phone
 * challenge's). Nothing waits in a table between the steps: there is no
 * "pending sign-in" row to expire, race or clean up. The code itself is never
 * in either token, only its tag, so a challenge in hand is not the code.
 *
 * Whoever holds a ticket can have a code sent to an address they choose, and
 * only the holder of THAT inbox can finish: the code is what proves the
 * address, as a provider's `email_verified` does for Google.
 */
const INFO = 'playerz/apple-email/v1';
const SALT = 'playerz/apple-email/salt';

export const APPLE_TICKET_TTL_MS = 30 * 60_000;
export const APPLE_CODE_TTL_MS = 10 * 60_000;
export const APPLE_CODE_DIGITS = 6;

export interface AppleTicket {
  /** The Apple ID: the identity token's `sub`. */
  subject: string;
  /** The name the app sent with its first authorisation, if any. */
  name: string | null;
  /** The language a NEW account starts in. */
  locale: string | null;
  expiresAt: number;
}

export interface AppleCodeChallenge extends AppleTicket {
  /** Where the code went: lower-cased, trimmed. */
  email: string;
  /** The keyed tag of `subject:email:code`. */
  codeTag: string;
}

function baseKeyMaterial(): string {
  const key = process.env.DATA_ENCRYPTION_KEY;
  if (key && key.length >= 32) return key;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATA_ENCRYPTION_KEY is required in production (Apple email step).');
  }
  return DEV_FALLBACK_DATA_ENCRYPTION_KEY;
}

let cached: { material: string; key: Buffer } | null = null;
function key(): Buffer {
  const material = baseKeyMaterial();
  if (cached?.material === material) return cached.key;
  const derived = Buffer.from(hkdfSync('sha256', material, SALT, INFO, 32));
  cached = { material, key: derived };
  return derived;
}

const mac = (text: string) => createHmac('sha256', key()).update(text, 'utf8').digest();

function sign(kind: 't' | 'c', fields: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify({ k: kind, ...fields }), 'utf8').toString('base64url');
  return `${payload}.${mac(payload).toString('base64url')}`;
}

function read(token: unknown, kind: 't' | 'c', now: number): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = mac(payload);
  // Length first: timingSafeEqual throws on a mismatch.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  // A ticket is not a challenge and the other way round: each step takes its own.
  if (p.k !== kind || typeof p.s !== 'string' || typeof p.x !== 'number' || p.x <= now) return null;
  return p;
}

const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null);

export function signAppleTicket(ticket: Omit<AppleTicket, 'expiresAt'>, now = Date.now()): string {
  return sign('t', {
    s: ticket.subject,
    n: ticket.name,
    l: ticket.locale,
    x: now + APPLE_TICKET_TTL_MS,
  });
}

export function readAppleTicket(token: unknown, now = Date.now()): AppleTicket | null {
  const p = read(token, 't', now);
  if (!p) return null;
  return {
    subject: p.s as string,
    name: strOrNull(p.n),
    locale: strOrNull(p.l),
    expiresAt: p.x as number,
  };
}

/** A fresh code, `APPLE_CODE_DIGITS` digits, leading zeros kept. */
export function newAppleCode(): string {
  return String(randomInt(0, 10 ** APPLE_CODE_DIGITS)).padStart(APPLE_CODE_DIGITS, '0');
}

const codeTagOf = (subject: string, email: string, code: string) =>
  mac(`${subject}:${email}:${code}`).toString('base64url');

export function signAppleCodeChallenge(
  ticket: AppleTicket,
  email: string,
  code: string,
  now = Date.now(),
): string {
  return sign('c', {
    s: ticket.subject,
    n: ticket.name,
    l: ticket.locale,
    e: email,
    t: codeTagOf(ticket.subject, email, code),
    x: now + APPLE_CODE_TTL_MS,
  });
}

export function readAppleCodeChallenge(
  token: unknown,
  now = Date.now(),
): AppleCodeChallenge | null {
  const p = read(token, 'c', now);
  if (!p || typeof p.e !== 'string' || typeof p.t !== 'string') return null;
  return {
    subject: p.s as string,
    name: strOrNull(p.n),
    locale: strOrNull(p.l),
    expiresAt: p.x as number,
    email: p.e,
    codeTag: p.t,
  };
}

/** Whether `code` is the one the challenge was made for. Constant-time. */
export function codeMatches(challenge: AppleCodeChallenge, code: string): boolean {
  if (!/^\d+$/.test(code) || code.length !== APPLE_CODE_DIGITS) return false;
  const given = Buffer.from(codeTagOf(challenge.subject, challenge.email, code));
  const expected = Buffer.from(challenge.codeTag);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
