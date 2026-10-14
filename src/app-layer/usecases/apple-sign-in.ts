import { createHash } from 'node:crypto';

import { resolveProviderAccount } from '@/app-layer/usecases/provider-account';
import {
  codeMatches,
  newAppleCode,
  readAppleCodeChallenge,
  readAppleTicket,
  signAppleCodeChallenge,
  signAppleTicket,
  APPLE_CODE_TTL_MS,
} from '@/lib/account/apple-email-challenge';
import { APPLE_RELAY_DOMAIN, type ProviderIdentity } from '@/lib/auth/native-grants';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { MailNotConfiguredError, MailNotSentError, sendMail } from '@/lib/email/mailer';
import { RateLimitedError } from '@/lib/errors/types';
import { isLocale, resolveLocale, type Locale } from '@/lib/i18n/locales';
import { translateFor } from '@/lib/i18n/server-messages';
import { logger } from '@/lib/observability/logger';
import { checkRateLimit, type RateLimitConfig } from '@/lib/security/rate-limit';

/**
 * SIGN IN WITH APPLE, AND THE HIDDEN ADDRESS (#442; owner decisions 2026-10-14).
 *
 * Accounts are found by email address, the same for Google, Facebook and
 * Apple, so club onboarding by address keeps working. Apple adds two things:
 *
 *   - the account remembers the Apple ID it was confirmed for
 *     (`app_user.appleSubject`, P76), and an Apple sign-in looks there first;
 *   - an address behind Apple's relay ("Hide My Email") is not one to find an
 *     account by: it differs per app and names nobody. Such a sign-in stops
 *     with a TICKET, the person types a real address, a code goes to it, and
 *     the code confirms it (`@/lib/account/apple-email-challenge`). Only then
 *     is the account found or made by that address, exactly as for Google.
 *
 * A real address Apple vouches for (`email_verified`) is used directly, as
 * Google's is.
 *
 * Runs as app_superuser: no tenant is bound during sign-in, and the reads are
 * one row by a UNIQUE key.
 */

export class AppleTicketInvalidError extends Error {
  constructor() {
    super('The Apple sign-in has expired. Sign in with Apple again.');
    this.name = 'AppleTicketInvalidError';
  }
}

export class EmailInvalidError extends Error {
  constructor() {
    super('That is not an email address.');
    this.name = 'EmailInvalidError';
  }
}

export class EmailIsRelayError extends Error {
  constructor() {
    super("That is Apple's hidden address. Type the address you use.");
    this.name = 'EmailIsRelayError';
  }
}

export class EmailCodeWrongError extends Error {
  constructor() {
    super('That is not the code we sent.');
    this.name = 'EmailCodeWrongError';
  }
}

export class EmailCodeExpiredError extends Error {
  constructor() {
    super('The code has expired. Ask for a new one.');
    this.name = 'EmailCodeExpiredError';
  }
}

export class EmailUnavailableError extends Error {
  constructor() {
    super('The code could not be sent right now.');
    this.name = 'EmailUnavailableError';
  }
}

/** Codes one Apple ID may ask for, and to one address: a few, then a pause. */
export const APPLE_CODE_PER_SUBJECT: RateLimitConfig = { maxAttempts: 3, windowMs: 60 * 60_000 };
export const APPLE_CODE_PER_ADDRESS: RateLimitConfig = { maxAttempts: 3, windowMs: 60 * 60_000 };
/** Guesses at one Apple ID's code. Six digits, five tries: one in 200 000. */
export const APPLE_CONFIRM_PER_SUBJECT: RateLimitConfig = { maxAttempts: 5, windowMs: 10 * 60_000 };

const isRelay = (email: string) => email.endsWith(`@${APPLE_RELAY_DOMAIN}`);

/** A name the app sent, in one line, or null. */
export function appleName(given: unknown, family: unknown): string | null {
  const part = (v: unknown) =>
    typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  const name = [part(given), part(family)].filter(Boolean).join(' ');
  return name || null;
}

async function accountBySubject(subject: string): Promise<string | null> {
  const row = await runAsSuperuser((db) =>
    db.user.findFirst({ where: { appleSubject: subject, deletedAt: null }, select: { id: true } }),
  );
  return row?.id ?? null;
}

/**
 * Remember the Apple ID on the account, unless it already remembers one. A
 * race with another sign-in for the same Apple ID loses quietly: the UNIQUE
 * index keeps one account per Apple ID, and this sign-in still goes ahead.
 */
async function linkSubject(userId: string, subject: string): Promise<void> {
  try {
    await runAsSuperuser((db) =>
      db.user.updateMany({
        where: { id: userId, appleSubject: null, deletedAt: null },
        data: { appleSubject: subject },
      }),
    );
  } catch (error) {
    logger.warn('apple sign-in: the Apple ID was not linked', {
      component: 'auth',
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}

async function signInByAddress(
  subject: string,
  email: string,
  name: string | null,
  locale: Locale | null,
): Promise<string> {
  const { userId } = await resolveProviderAccount({
    provider: 'apple',
    email,
    name,
    picture: null,
    locale,
  });
  await linkSubject(userId, subject);
  return userId;
}

/**
 * The account an Apple sign-in lands in, or a ticket to confirm a real
 * address first. `who` is a verified Apple identity (`verifyAppleIdToken`).
 */
export async function appleSignIn(
  who: ProviderIdentity,
  name: string | null,
  locale: Locale | null,
): Promise<{ userId: string } | { ticket: string }> {
  const subject = who.subject;
  if (!subject) throw new AppleTicketInvalidError();

  const known = await accountBySubject(subject);
  if (known) return { userId: known };

  if (who.email && who.emailVerified && !who.privateEmail && !isRelay(who.email)) {
    return { userId: await signInByAddress(subject, who.email, name, locale) };
  }
  return { ticket: signAppleTicket({ subject, name, locale }) };
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function addressOf(raw: unknown): string {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_SHAPE.test(email)) throw new EmailInvalidError();
  if (isRelay(email)) throw new EmailIsRelayError();
  return email;
}

const fingerprint = (email: string) =>
  createHash('sha256').update(email).digest('hex').slice(0, 32);

/**
 * Send a code to the address the person typed, and hand back the challenge
 * the confirm step takes. Says nothing about whether an account has that
 * address: that is answered by signing in, after the code proves the inbox.
 */
export async function sendAppleEmailCode(
  ticketToken: unknown,
  rawEmail: unknown,
): Promise<{ challenge: string; expiresInSeconds: number }> {
  const ticket = readAppleTicket(ticketToken);
  if (!ticket) throw new AppleTicketInvalidError();
  const email = addressOf(rawEmail);

  for (const [key, cfg] of [
    [`apple-email:sub:${ticket.subject}`, APPLE_CODE_PER_SUBJECT],
    [`apple-email:to:${fingerprint(email)}`, APPLE_CODE_PER_ADDRESS],
  ] as const) {
    const limit = await checkRateLimit(key, cfg);
    if (!limit.allowed) throw new RateLimitedError('Too many codes asked for. Try again later.');
  }

  const code = newAppleCode();
  const challenge = signAppleCodeChallenge(ticket, email, code);
  const locale = resolveLocale(ticket.locale);
  const minutes = Math.round(APPLE_CODE_TTL_MS / 60_000);
  const [subject, intro, lasts, footer] = await Promise.all([
    translateFor(locale, 'emails.appleCode.subject', { code }),
    translateFor(locale, 'emails.appleCode.intro'),
    translateFor(locale, 'emails.appleCode.lasts', { minutes }),
    translateFor(locale, 'emails.appleCode.footer'),
  ]);
  try {
    await sendMail({
      to: email,
      subject,
      text: [intro, '', code, '', lasts, '', '—', footer].join('\n'),
      ref: 'apple-email-code',
    });
  } catch (error) {
    if (error instanceof MailNotConfiguredError || error instanceof MailNotSentError) {
      logger.warn('apple sign-in: the code email was not sent', {
        component: 'auth',
        error: error.name,
      });
      throw new EmailUnavailableError();
    }
    throw error;
  }
  return { challenge, expiresInSeconds: APPLE_CODE_TTL_MS / 1000 };
}

/**
 * The code is right: the address is the person's. The account is found or
 * made by it, as a Google sign-in's would be, and remembers the Apple ID.
 */
export async function confirmAppleEmail(
  challengeToken: unknown,
  rawCode: unknown,
): Promise<{ userId: string }> {
  const challenge = readAppleCodeChallenge(challengeToken);
  if (!challenge) throw new EmailCodeExpiredError();

  const limit = await checkRateLimit(
    `apple-confirm:${challenge.subject}`,
    APPLE_CONFIRM_PER_SUBJECT,
  );
  if (!limit.allowed) throw new RateLimitedError('Too many tries. Ask for a new code later.');

  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!codeMatches(challenge, code)) throw new EmailCodeWrongError();

  const known = await accountBySubject(challenge.subject);
  if (known) return { userId: known };
  const locale = isLocale(challenge.locale) ? challenge.locale : null;
  return {
    userId: await signInByAddress(challenge.subject, challenge.email, challenge.name, locale),
  };
}
