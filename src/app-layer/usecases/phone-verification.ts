import type { PrismaClient } from '@prisma/client';

import {
  PHONE_CHALLENGE_TTL_MS,
  readPhoneChallenge,
  signPhoneChallenge,
} from '@/lib/account/phone-challenge';
import { maskPhone, phoneFingerprint } from '@/lib/account/phone-fingerprint';
import { phoneClaim } from '@/lib/auth/phone-ask';
import { normalizePhone } from '@/lib/booking/phone';
import { runAsUserOnly } from '@/lib/db/rls-middleware';
import { RateLimitedError } from '@/lib/errors/types';
import { resolveLocale } from '@/lib/i18n/locales';
import { logger } from '@/lib/observability/logger';
import { decryptField, encryptField } from '@/lib/security/encryption';
import { checkRateLimit, type RateLimitConfig } from '@/lib/security/rate-limit';
import { phoneRequired, phoneVerifier } from '@/lib/sms/phone-verifier';

import { inheritNoShowStandingByPhone } from './no-show-carry';

/**
 * A phone number, confirmed by an SMS code (#500; owner decisions 2026-10-13).
 *
 * ═══ WHY ═══
 *
 * A blocked person makes a new account with a new address. A phone number is
 * harder to replace, so: every player and coach confirms one before their
 * first booking, join request or message; a number confirms ONE account at a
 * time; and a number that belonged to an account with a no-show standing,
 * a deleted one included, brings that standing to the account that confirms
 * it next.
 *
 * ═══ THE TWO STEPS ═══
 *
 *   start     the person types a number; a code is sent to it by SMS, and
 *             the client gets a challenge to send back
 *   confirm   the person types the code; with the challenge and the same
 *             number, the number becomes the account's
 *
 * The code is the SMS provider's from start to end (Infobip's 2FA API,
 * src/lib/sms/phone-verifier.ts): playerz never holds one. What playerz adds
 * is its own limits, on the person and on the number, so a signed-in account
 * cannot use the step to text the same stranger again and again; and the
 * CHALLENGE that `start` hands out and `confirm` takes back
 * (src/lib/account/phone-challenge.ts), which ties the code that was sent to
 * this account and this number. The provider checks a code by its own id and
 * knows nothing of either.
 *
 * ═══ "THIS NUMBER IS TAKEN" IS SAID ONLY TO ITS HOLDER ═══
 *
 * `start` sends a code to any valid number and says nothing about it. Whether
 * another account holds the number is answered at `confirm`, after the code
 * has proved the caller holds the phone: otherwise the step would tell anyone
 * who asks whether a given number has a playerz account.
 *
 * ═══ WHAT IS STORED (P65) ═══
 *
 * `phone` encrypted, `phoneHash` (the keyed fingerprint, UNIQUE) and
 * `phoneVerifiedAt`. All three together or none. Changing the number is the
 * same two steps with the new one; the old number is then free.
 *
 * Bound to the person (`runAsUserOnly`), never the superuser handle: the
 * account's own row is all this writes, and "is the number taken" is one
 * lookup by a keyed fingerprint under a UNIQUE index, which returns an id and
 * nothing else. The carried standing is taken over in no-show-carry.ts, as it
 * is at sign-in.
 */

export class PhoneInvalidError extends Error {
  constructor() {
    super('That is not a phone number that can receive a code.');
    this.name = 'PhoneInvalidError';
  }
}

export class PhoneCodeWrongError extends Error {
  constructor() {
    super('That is not the code we sent.');
    this.name = 'PhoneCodeWrongError';
  }
}

export class PhoneCodeExpiredError extends Error {
  constructor() {
    super('The code has expired, or none was sent to this number. Ask for a new one.');
    this.name = 'PhoneCodeExpiredError';
  }
}

export class PhoneInUseError extends Error {
  constructor() {
    super('This number already confirms another account.');
    this.name = 'PhoneInUseError';
  }
}

export class PhoneVerifyUnavailableError extends Error {
  constructor() {
    super('Phone confirmation is not available right now.');
    this.name = 'PhoneVerifyUnavailableError';
  }
}

/** Booking, asking to join a game or writing a message without a confirmed number (#500). */
export class PhoneRequiredError extends Error {
  constructor() {
    super('Confirm a phone number first.');
    this.name = 'PhoneRequiredError';
  }
}

/** Codes one account may ask for: a few, then a pause. The provider has its own limits beneath. */
export const PHONE_START_PER_USER: RateLimitConfig = { maxAttempts: 5, windowMs: 60 * 60_000 };
/** Codes one NUMBER may be sent, whoever asks: nobody is texted more than this by us. */
export const PHONE_START_PER_NUMBER: RateLimitConfig = { maxAttempts: 3, windowMs: 60 * 60_000 };
export const PHONE_START_PER_NUMBER_DAILY: RateLimitConfig = {
  maxAttempts: 6,
  windowMs: 24 * 60 * 60_000,
};
/** Guesses one account may make. The provider stops a single code after a few. */
export const PHONE_CONFIRM_PER_USER: RateLimitConfig = { maxAttempts: 10, windowMs: 60 * 60_000 };

async function limited(key: string, config: RateLimitConfig, message: string): Promise<void> {
  const r = await checkRateLimit(key, config);
  if (!r.allowed) throw new RateLimitedError(message);
}

function verifierOrThrow() {
  const verifier = phoneVerifier();
  if (!verifier) {
    logger.error('the phone step was used with no verifier configured (INFOBIP_* unset)', {
      component: 'phone-verify',
    });
    throw new PhoneVerifyUnavailableError();
  }
  return verifier;
}

function e164OrThrow(raw: string): string {
  const e164 = normalizePhone(raw);
  if (!e164) throw new PhoneInvalidError();
  return e164;
}

export interface PhoneStanding {
  /** Is a confirmed number required before booking, joining a game or writing? */
  required: boolean;
  /** Is this an account that is asked for one: a player or a coach? */
  applies: boolean;
  verified: boolean;
  /** The confirmed number with its middle hidden (`+35988*****56`), or null. */
  number: string | null;
  verifiedAt: Date | null;
}

/** What the account's own screens show about its number. Null: no such account. */
export async function phoneStanding(userId: string): Promise<PhoneStanding | null> {
  const user = await runAsUserOnly(userId, (db) =>
    db.user.findUnique({
      where: { id: userId },
      select: { phone: true, phoneVerifiedAt: true, accountKind: true, deletedAt: true },
    }),
  );
  if (!user || user.deletedAt) return null;
  const verified = user.phoneVerifiedAt !== null && user.phone !== null;
  let number: string | null = null;
  if (verified) {
    try {
      number = maskPhone(decryptField(user.phone!));
    } catch {
      // A value this key cannot read (a rotated key): confirmed, shown as hidden.
      number = null;
    }
  }
  return {
    required: phoneRequired(),
    applies: phoneClaim(user) !== 'na',
    verified,
    number,
    verifiedAt: user.phoneVerifiedAt,
  };
}

/** Send a code to the number. Says nothing about whether the number is known. */
export async function startPhoneVerification(
  userId: string,
  rawPhone: string,
  rawLocale: unknown,
  now: Date = new Date(),
): Promise<{ sent: true; number: string; challenge: string }> {
  const verifier = verifierOrThrow();
  const e164 = e164OrThrow(rawPhone);
  const fingerprint = phoneFingerprint(e164);

  await limited(
    `phone-start:u:${userId}`,
    PHONE_START_PER_USER,
    'Too many codes asked for. Try again in an hour.',
  );
  await limited(
    `phone-start:n:${fingerprint}`,
    PHONE_START_PER_NUMBER,
    'Too many codes sent to this number. Try again in an hour.',
  );
  await limited(
    `phone-start:nd:${fingerprint}`,
    PHONE_START_PER_NUMBER_DAILY,
    'Too many codes sent to this number today.',
  );

  const started = await verifier.start(e164, resolveLocale(rawLocale));
  if (!started.ok) {
    if (started.reason === 'invalid') throw new PhoneInvalidError();
    if (started.reason === 'limited') {
      throw new RateLimitedError('Too many codes sent to this number. Try again later.');
    }
    throw new PhoneVerifyUnavailableError();
  }
  return {
    sent: true,
    number: maskPhone(e164),
    // What `confirm` takes back: this account, this number, this code.
    challenge: signPhoneChallenge({
      userId,
      fingerprint,
      ref: started.ref,
      expiresAt: now.getTime() + PHONE_CHALLENGE_TTL_MS,
    }),
  };
}

/**
 * Check the code and make the number the account's. On success the account
 * also takes over any no-show standing the number carries from a deleted
 * account; `inherited` says how many missed bookings came with it.
 */
export async function confirmPhoneVerification(
  userId: string,
  rawPhone: string,
  code: string,
  challengeToken: string,
  now: Date = new Date(),
): Promise<{ verified: true; number: string; inherited: number }> {
  const verifier = verifierOrThrow();
  const e164 = e164OrThrow(rawPhone);
  const fingerprint = phoneFingerprint(e164);

  await limited(
    `phone-confirm:u:${userId}`,
    PHONE_CONFIRM_PER_USER,
    'Too many attempts. Try again in an hour.',
  );

  // The challenge from `start`: ours, not expired, made for THIS account and
  // for THIS number. Anything else is "ask for a new code": it says nothing
  // about why, and nothing is asked of the provider.
  const challenge = readPhoneChallenge(challengeToken, now.getTime());
  if (!challenge || challenge.userId !== userId || challenge.fingerprint !== fingerprint) {
    throw new PhoneCodeExpiredError();
  }

  const checked = await verifier.check(challenge.ref, code);
  if (!checked.ok) {
    if (checked.reason === 'wrong') throw new PhoneCodeWrongError();
    if (checked.reason === 'expired') throw new PhoneCodeExpiredError();
    if (checked.reason === 'limited') {
      throw new RateLimitedError('Too many wrong codes. Ask for a new one.');
    }
    throw new PhoneVerifyUnavailableError();
  }

  // The caller holds the phone. Now, and only now, may they learn it is taken.
  await runAsUserOnly(userId, async (db) => {
    const holder = await db.user.findUnique({
      where: { phoneHash: fingerprint },
      select: { id: true },
    });
    if (holder && holder.id !== userId) throw new PhoneInUseError();
    try {
      const { count } = await db.user.updateMany({
        where: { id: userId, deletedAt: null },
        data: { phone: encryptField(e164), phoneHash: fingerprint, phoneVerifiedAt: new Date() },
      });
      // A session whose account was deleted meanwhile: nothing to confirm.
      if (count === 0) throw new PhoneVerifyUnavailableError();
    } catch (err) {
      // Two accounts confirming one number at the same moment: the UNIQUE
      // index decides, and the loser is told what the check above would have.
      if ((err as { code?: string }).code === 'P2002') throw new PhoneInUseError();
      throw err;
    }
  });

  const inherited = await inheritNoShowStandingByPhone(userId, fingerprint);
  return { verified: true, number: maskPhone(e164), inherited };
}

/**
 * The gate (#500): throws `PhoneRequiredError` when the rule is on and this
 * account has no confirmed number. Called before a player books, joins a
 * booking by link, asks to join a game, or writes a message. Club staff are
 * not asked: they act for the club, at its desk and in its inbox.
 */
export async function assertPhoneConfirmed(userId: string, db?: PrismaClient): Promise<void> {
  if (!phoneRequired()) return;
  const read = (h: PrismaClient) =>
    h.user.findUnique({ where: { id: userId }, select: { phoneVerifiedAt: true } });
  // Inside a caller's transaction when it has one (the accounts table has no
  // row security, so any binding reads the one row); else bound to the person.
  const user = db ? await read(db) : await runAsUserOnly(userId, read);
  if (!user?.phoneVerifiedAt) throw new PhoneRequiredError();
}
