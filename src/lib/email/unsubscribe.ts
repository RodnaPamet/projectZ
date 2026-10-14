import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

import { DEV_FALLBACK_DATA_ENCRYPTION_KEY } from '@/lib/security/encryption-constants';
import { absoluteUrl } from '@/lib/seo/site-url';

/**
 * One-click unsubscribe (#528): the link in an email's footer, and the
 * `List-Unsubscribe` header a mail client turns into its own button.
 *
 * ═══ WHAT A LINK CAN DO ═══
 *
 * Exactly one thing: switch OFF one kind of email for one account, the kind
 * the email it came in belongs to. It is the same switch as Профил → Известия,
 * reached without signing in, because a person who wants an email to stop
 * should not have to remember a password first. It cannot switch anything on,
 * read anything, or touch another kind.
 *
 * ═══ THE TOKEN ═══
 *
 *   base64url("<userId>:<category>") . base64url(HMAC-SHA256(payload))
 *
 * Signed, not stored: nothing to look up, nothing to clean up. It does not
 * expire, on purpose. An email sits in an inbox for years, and its link must
 * still work the day somebody finally presses it. What it can do is small
 * enough for that to be safe: the worst a forwarded email does is stop a kind
 * of email, which the person switches back on in their profile.
 *
 * The key is HKDF-derived from DATA_ENCRYPTION_KEY with a label of its own, as
 * the phone challenge's is. Rotating the base key voids every link already
 * sent; the footer's other line (Профил → Известия) still works.
 */

/** The kinds a person can switch off: the same ones as their settings. */
export const UNSUBSCRIBE_CATEGORIES = [
  'confirmation',
  'reminder',
  'clubChanges',
  'messages',
  'openPlay',
  // A coach's emails about the lessons they teach (#550).
  'lessonsTaught',
] as const;
export type UnsubscribeCategory = (typeof UNSUBSCRIBE_CATEGORIES)[number];

export function isUnsubscribeCategory(value: unknown): value is UnsubscribeCategory {
  return typeof value === 'string' && (UNSUBSCRIBE_CATEGORIES as readonly string[]).includes(value);
}

export const UNSUBSCRIBE_INFO = 'playerz/email-unsubscribe/v1';
const SALT = 'playerz/email-unsubscribe/salt';

function baseKeyMaterial(): string {
  const key = process.env.DATA_ENCRYPTION_KEY;
  if (key && key.length >= 32) return key;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATA_ENCRYPTION_KEY is required in production (email unsubscribe).');
  }
  return DEV_FALLBACK_DATA_ENCRYPTION_KEY;
}

let cached: { material: string; key: Buffer } | null = null;

function signingKey(): Buffer {
  const material = baseKeyMaterial();
  if (cached?.material === material) return cached.key;
  const key = Buffer.from(hkdfSync('sha256', material, SALT, UNSUBSCRIBE_INFO, 32));
  cached = { material, key };
  return key;
}

const tagOf = (payload: string) =>
  createHmac('sha256', signingKey()).update(payload, 'utf8').digest();

export function unsubscribeToken(userId: string, category: UnsubscribeCategory): string {
  const payload = Buffer.from(`${userId}:${category}`, 'utf8').toString('base64url');
  return `${payload}.${tagOf(payload).toString('base64url')}`;
}

/** Who and which kind, or null for anything this server did not sign. */
export function readUnsubscribeToken(
  token: unknown,
): { userId: string; category: UnsubscribeCategory } | null {
  if (typeof token !== 'string' || token.length > 400) return null;
  const [payload, tag, ...rest] = token.split('.');
  if (!payload || !tag || rest.length > 0) return null;

  const given = Buffer.from(tag, 'base64url');
  const expected = tagOf(payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  const at = decoded.lastIndexOf(':');
  if (at <= 0) return null;
  const userId = decoded.slice(0, at);
  const category = decoded.slice(at + 1);
  return isUnsubscribeCategory(category) ? { userId, category } : null;
}

/** The page a person reads and confirms on: the footer's link. */
export function unsubscribePagePath(token: string): string {
  return `/email/unsubscribe/${token}`;
}

/** The address a mail client POSTs to (RFC 8058): the header's link. */
export function unsubscribeOneClickPath(token: string): string {
  return `/api/email/unsubscribe/${token}`;
}

/**
 * What an email carries for one account and one kind: the footer's link, and
 * the two headers that make Gmail, Apple Mail and the rest show their own
 * "unsubscribe" beside the sender.
 *
 * `List-Unsubscribe-Post` is RFC 8058's promise that a POST to that address,
 * with no cookies and nothing but `List-Unsubscribe=One-Click` in its body,
 * does it. That is why the header's link is the API route and not the page.
 */
export function unsubscribeLinks(
  userId: string,
  category: UnsubscribeCategory,
): { pageUrl: string; headers: Record<string, string> } {
  const token = unsubscribeToken(userId, category);
  return {
    pageUrl: absoluteUrl(unsubscribePagePath(token)),
    headers: {
      'List-Unsubscribe': `<${absoluteUrl(unsubscribeOneClickPath(token))}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
