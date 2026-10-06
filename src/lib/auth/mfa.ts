import type { PrismaClient } from '@prisma/client';

import {
  MfaAlreadyEnrolledError,
  MfaCodeRejectedError,
  MfaEnrolmentNotStartedError,
  MfaEnrolmentRequiredError,
  MfaNotEligibleError,
  MfaReauthRequiredError,
  PlatformStepUpRequiredError,
} from '@/lib/auth/mfa-errors';
import { resolvePlatformAuthority } from '@/lib/auth/platform-admin';
import { isStepUpFresh, stepUpExpiresAt } from '@/lib/auth/step-up';
import {
  hashRecoveryCode,
  looksLikeRecoveryCode,
  looksLikeTotp,
  newRecoveryCode,
  newTotpSecret,
  otpauthUri,
  RECOVERY_CODE_COUNT,
  verifyTotp,
} from '@/lib/auth/totp';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { RateLimitedError } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { decryptField, encryptField } from '@/lib/security/encryption';
import {
  checkRateLimit,
  MFA_ENROLL_VERIFY_LIMIT,
  MFA_VERIFY_DAILY_LIMIT,
  MFA_VERIFY_LIMIT,
} from '@/lib/security/rate-limit';

/**
 * The second factor (#262): TOTP enrolment, recovery codes, and the step-up
 * that every cross-club write requires.
 *
 * ═══ WHERE EACH SECRET LIVES ═══
 *
 *   TOTP seed        app_user.mfaSecret — the `v1:` AES-256-GCM envelope
 *                    (`encryptField`), decrypted only inside a verify here.
 *                    A DB CHECK refuses anything that is not the envelope.
 *   recovery codes   mfa_recovery_code.codeHash — SHA-256 of an 80-bit code,
 *                    salted with the user id. Shown ONCE, at issue.
 *   the step-up      user_session.mfaVerifiedAt — on the session row, so it
 *                    dies with the session and is never shared between two.
 *
 * ═══ WHAT EVERY VERIFY DOES, IN ORDER ═══
 *
 *   1. rate limit, per USER (a stolen session is one user; an IP is cheap to
 *      change): 5 per 15 minutes with a 5-minute lockout, and 50 a day;
 *   2. verify in constant time against ±1 step;
 *   3. accept the step only if it is AFTER the last accepted one, with a
 *      conditional UPDATE — so a code cannot be replayed inside its ~90 s
 *      window, not even by two requests racing;
 *   4. write an append-only account_security_event row, success OR failure.
 *
 * The failure row is written in its own transaction, AFTER the verify's has
 * settled, so throwing the refusal never rolls back the record of it.
 *
 * ═══ SCOPE ═══
 *
 * Enrolment is open to holders of a live platform grant — "platform admins at
 * least", as #262 puts it. Whether club accounts should also enrol is a product
 * question the issue does not settle, so it is not guessed at here.
 */

/** Verbs written to account_security_event. A constant, so a typo is a type error. */
export const MFA_EVENTS = {
  ENROLMENT_STARTED: 'MFA_ENROLMENT_STARTED',
  ENROLMENT_CONFIRMED: 'MFA_ENROLMENT_CONFIRMED',
  ENROLMENT_CONFIRM_FAILED: 'MFA_ENROLMENT_CONFIRM_FAILED',
  STEP_UP_SUCCEEDED: 'MFA_STEP_UP_SUCCEEDED',
  STEP_UP_FAILED: 'MFA_STEP_UP_FAILED',
  STEP_UP_RATE_LIMITED: 'MFA_STEP_UP_RATE_LIMITED',
  RECOVERY_CODE_USED: 'MFA_RECOVERY_CODE_USED',
  RECOVERY_CODES_REGENERATED: 'MFA_RECOVERY_CODES_REGENERATED',
} as const;

type MfaEvent = (typeof MFA_EVENTS)[keyof typeof MFA_EVENTS];

/**
 * How recent the sign-in must be to enrol: 15 minutes.
 *
 * The first enrolment is trust-on-first-use, so it is the one moment a stolen
 * session could plant the thief's authenticator. Requiring a session created in
 * the last few minutes means the thief needs the password or the identity
 * provider account too, not just a cookie.
 */
export const MFA_ENROL_FRESH_SIGN_IN_SECONDS = 15 * 60;

/** Who is asking, and from where — every field ends up in the event row. */
export interface MfaCaller {
  userId: string;
  /** The session the step-up will be bound to. Required: no session, no step-up. */
  userSessionId: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface MfaStatus {
  /** May enrol: holds a live platform grant. */
  eligible: boolean;
  enrolled: boolean;
  /** Enrolment started and not yet confirmed. */
  pending: boolean;
  /** When THIS session's step-up stops counting — null if it has none that counts. */
  stepUpExpiresAt: Date | null;
  recoveryCodesRemaining: number;
}

async function record(
  db: PrismaClient,
  caller: MfaCaller,
  action: MfaEvent,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.accountSecurityEvent.create({
    data: {
      userId: caller.userId,
      userSessionId: caller.userSessionId,
      action,
      detailsJson: details as never,
      requestId: caller.requestId ?? null,
      ipAddress: caller.ipAddress ?? null,
      userAgent: caller.userAgent ?? null,
    },
  });
}

/** A refusal's record, in a transaction of its own so the refusal cannot roll it back. */
async function recordFailure(
  caller: MfaCaller,
  action: MfaEvent,
  details: Record<string, unknown>,
) {
  await runAsSuperuser((db) => record(db, caller, action, details));
}

/** Both verify budgets, spent together. Throws 429 when either is exhausted. */
async function spendVerifyBudget(caller: MfaCaller, kind: 'step-up' | 'enrol'): Promise<void> {
  const checks =
    kind === 'enrol'
      ? [checkRateLimit(`mfa:enrol:u:${caller.userId}`, MFA_ENROLL_VERIFY_LIMIT)]
      : [
          checkRateLimit(`mfa:verify:u:${caller.userId}`, MFA_VERIFY_LIMIT),
          checkRateLimit(`mfa:verify-day:u:${caller.userId}`, MFA_VERIFY_DAILY_LIMIT),
        ];
  const results = await Promise.all(checks);
  if (results.every((r) => r.allowed)) return;

  logger.warn('mfa verify rate-limited', { component: 'mfa', kind, userId: caller.userId });
  await recordFailure(caller, MFA_EVENTS.STEP_UP_RATE_LIMITED, { kind });
  throw new RateLimitedError('Too many second-factor attempts. Wait and try again.');
}

function requireSession(caller: MfaCaller): string {
  // A step-up is a property of a session. A caller without one (a context
  // built some other way) has nothing to bind it to, and binding it to the
  // USER instead would hand it to every session they hold.
  if (!caller.userSessionId) throw new PlatformStepUpRequiredError();
  return caller.userSessionId;
}

async function issueRecoveryCodes(db: PrismaClient, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  // Serialise on the account row first. Without it two regenerations racing
  // under READ COMMITTED each delete only the rows their statement could see,
  // and BOTH new sets survive — twenty live codes, ten of which the person
  // was shown in a response they may never have read.
  await db.$executeRawUnsafe(`SELECT 1 FROM app_user WHERE id = $1 FOR UPDATE`, userId);
  // Regeneration replaces the whole set: an old code that still worked after
  // "I printed new ones" would be a code nobody is guarding.
  await db.mfaRecoveryCode.deleteMany({ where: { userId } });
  await db.mfaRecoveryCode.createMany({
    data: codes.map((code) => ({ userId, codeHash: hashRecoveryCode(userId, code) })),
  });
  return codes;
}

/**
 * Accept `step` for `userId` if, and only if, it is after the last accepted
 * one. A conditional UPDATE, so of two requests carrying the same code exactly
 * one is accepted.
 */
async function claimStep(db: PrismaClient, userId: string, step: number): Promise<boolean> {
  const claimed = await db.user.updateMany({
    where: {
      id: userId,
      OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: BigInt(step) } }],
    },
    data: { mfaLastUsedStep: BigInt(step) },
  });
  return claimed.count === 1;
}

/** Bind a fresh step-up to the caller's session. Null if the session is not live. */
async function markSessionStepped(
  db: PrismaClient,
  userId: string,
  userSessionId: string,
  now: Date,
): Promise<Date | null> {
  const updated = await db.userSession.updateMany({
    where: { id: userSessionId, userId, revokedAt: null, expiresAt: { gt: now } },
    data: { mfaVerifiedAt: now },
  });
  return updated.count === 1 ? now : null;
}

// ─── Status ─────────────────────────────────────────────────────────────

export async function getMfaStatus(caller: MfaCaller, now: Date = new Date()): Promise<MfaStatus> {
  const [{ grantId }, row] = await Promise.all([
    resolvePlatformAuthority(caller.userId, now),
    runAsSuperuser(async (db) => {
      const user = await db.user.findUnique({
        where: { id: caller.userId },
        select: { mfaSecret: true, mfaEnabledAt: true },
      });
      const session = caller.userSessionId
        ? await db.userSession.findFirst({
            where: { id: caller.userSessionId, userId: caller.userId, revokedAt: null },
            select: { mfaVerifiedAt: true },
          })
        : null;
      const remaining = await db.mfaRecoveryCode.count({
        where: { userId: caller.userId, usedAt: null },
      });
      return { user, session, remaining };
    }),
  ]);

  const enrolled = !!row.user?.mfaEnabledAt;
  const verifiedAt = row.session?.mfaVerifiedAt ?? null;
  return {
    eligible: grantId !== null,
    enrolled,
    pending: !enrolled && !!row.user?.mfaSecret,
    stepUpExpiresAt:
      enrolled && isStepUpFresh(verifiedAt, now) ? stepUpExpiresAt(verifiedAt) : null,
    recoveryCodesRemaining: enrolled ? row.remaining : 0,
  };
}

// ─── Enrolment ──────────────────────────────────────────────────────────

/**
 * Start (or restart) enrolment: a new secret, encrypted at rest, returned once
 * so the person can add it to an authenticator.
 *
 * Refused for an account that is already enrolled. Replacing an enrolled
 * authenticator is an operator reset, deliberately: otherwise a stolen session
 * that has stepped up once could swap in its own phone and keep the power
 * after the owner's session is revoked.
 */
export async function startEnrolment(
  caller: MfaCaller,
  now: Date = new Date(),
): Promise<{ secret: string; otpauthUri: string }> {
  const userSessionId = requireSession(caller);
  const { grantId } = await resolvePlatformAuthority(caller.userId, now);
  if (!grantId) throw new MfaNotEligibleError();

  const secret = newTotpSecret();

  const email = await runAsSuperuser(async (db) => {
    const session = await db.userSession.findFirst({
      where: { id: userSessionId, userId: caller.userId, revokedAt: null },
      select: { createdAt: true, user: { select: { email: true } } },
    });
    // `!session.user`: deleted between Prisma's two selects (#419). No live session.
    if (!session?.user) throw new PlatformStepUpRequiredError();
    if (now.getTime() - session.createdAt.getTime() > MFA_ENROL_FRESH_SIGN_IN_SECONDS * 1000) {
      throw new MfaReauthRequiredError();
    }

    // Conditional on not being enrolled, so a race with a confirm cannot
    // overwrite the secret of an enrolment that just completed.
    const written = await db.user.updateMany({
      where: { id: caller.userId, mfaEnabledAt: null },
      data: { mfaSecret: encryptField(secret), mfaLastUsedStep: null },
    });
    if (written.count !== 1) throw new MfaAlreadyEnrolledError();

    await record(db, caller, MFA_EVENTS.ENROLMENT_STARTED);
    return session.user.email;
  });

  return { secret, otpauthUri: otpauthUri(secret, email) };
}

/**
 * Confirm enrolment with the first code from the authenticator. On success the
 * second factor is on, ten recovery codes are issued (returned here and never
 * again), and this session is stepped up — the person just proved the factor.
 */
export async function confirmEnrolment(
  caller: MfaCaller,
  code: string,
  now: Date = new Date(),
): Promise<{ recoveryCodes: string[]; stepUpExpiresAt: Date }> {
  const userSessionId = requireSession(caller);
  const { grantId } = await resolvePlatformAuthority(caller.userId, now);
  if (!grantId) throw new MfaNotEligibleError();

  await spendVerifyBudget(caller, 'enrol');

  const outcome = await runAsSuperuser(async (db) => {
    const user = await db.user.findUnique({
      where: { id: caller.userId },
      select: { mfaSecret: true, mfaEnabledAt: true },
    });
    if (user?.mfaEnabledAt) throw new MfaAlreadyEnrolledError();
    if (!user?.mfaSecret) throw new MfaEnrolmentNotStartedError();

    const step = verifyTotp(decryptField(user.mfaSecret), code, now.getTime());
    if (step === null || !(await claimStep(db, caller.userId, step))) {
      return { ok: false as const };
    }

    const enabled = await db.user.updateMany({
      where: { id: caller.userId, mfaEnabledAt: null },
      data: { mfaEnabledAt: now },
    });
    if (enabled.count !== 1) throw new MfaAlreadyEnrolledError();

    const recoveryCodes = await issueRecoveryCodes(db, caller.userId);
    const steppedAt = await markSessionStepped(db, caller.userId, userSessionId, now);
    if (!steppedAt) throw new PlatformStepUpRequiredError();

    await record(db, caller, MFA_EVENTS.ENROLMENT_CONFIRMED, {
      recoveryCodesIssued: recoveryCodes.length,
    });
    return { ok: true as const, recoveryCodes, steppedAt };
  });

  if (!outcome.ok) {
    await recordFailure(caller, MFA_EVENTS.ENROLMENT_CONFIRM_FAILED, {});
    throw new MfaCodeRejectedError();
  }
  return {
    recoveryCodes: outcome.recoveryCodes,
    stepUpExpiresAt: stepUpExpiresAt(outcome.steppedAt)!,
  };
}

// ─── Step-up ────────────────────────────────────────────────────────────

export interface StepUpProof {
  /** Six digits from the authenticator. */
  code?: string;
  /** One of the recovery codes, spent by this call. */
  recoveryCode?: string;
}

/**
 * Prove the second factor on this session. The step-up then lasts
 * MFA_STEP_UP_WINDOW_SECONDS for this session only.
 */
export async function stepUp(
  caller: MfaCaller,
  proof: StepUpProof,
  now: Date = new Date(),
): Promise<{
  stepUpExpiresAt: Date;
  method: 'totp' | 'recovery_code';
  recoveryCodesRemaining: number;
}> {
  const userSessionId = requireSession(caller);
  const method = proof.recoveryCode !== undefined ? 'recovery_code' : 'totp';
  const given = (method === 'totp' ? proof.code : proof.recoveryCode) ?? '';

  await spendVerifyBudget(caller, 'step-up');

  const outcome = await runAsSuperuser(async (db) => {
    const user = await db.user.findUnique({
      where: { id: caller.userId },
      select: { mfaSecret: true, mfaEnabledAt: true },
    });
    if (!user?.mfaEnabledAt || !user.mfaSecret) throw new MfaEnrolmentRequiredError();

    let accepted = false;
    if (method === 'totp') {
      if (looksLikeTotp(given)) {
        const step = verifyTotp(decryptField(user.mfaSecret), given, now.getTime());
        accepted = step !== null && (await claimStep(db, caller.userId, step));
      }
    } else if (looksLikeRecoveryCode(given)) {
      // Spending IS the check: one conditional UPDATE, matched by hash. A
      // spent or unknown code updates nothing. The comparison happens in an
      // index lookup on a SHA-256, so there is no prefix for timing to leak.
      const spent = await db.mfaRecoveryCode.updateMany({
        where: {
          userId: caller.userId,
          codeHash: hashRecoveryCode(caller.userId, given),
          usedAt: null,
        },
        data: { usedAt: now },
      });
      accepted = spent.count === 1;
    }

    if (!accepted) return { ok: false as const };

    const steppedAt = await markSessionStepped(db, caller.userId, userSessionId, now);
    // The session was revoked between the request's session check and here.
    // Throwing rolls back the spent code, which is right: nothing was gained.
    if (!steppedAt) throw new PlatformStepUpRequiredError();

    const remaining = await db.mfaRecoveryCode.count({
      where: { userId: caller.userId, usedAt: null },
    });
    if (method === 'recovery_code') {
      await record(db, caller, MFA_EVENTS.RECOVERY_CODE_USED, {
        recoveryCodesRemaining: remaining,
      });
    }
    await record(db, caller, MFA_EVENTS.STEP_UP_SUCCEEDED, { method });
    return { ok: true as const, steppedAt, remaining };
  });

  if (!outcome.ok) {
    await recordFailure(caller, MFA_EVENTS.STEP_UP_FAILED, { method });
    throw new MfaCodeRejectedError();
  }
  return {
    stepUpExpiresAt: stepUpExpiresAt(outcome.steppedAt)!,
    method,
    recoveryCodesRemaining: outcome.remaining,
  };
}

// ─── Recovery codes ─────────────────────────────────────────────────────

/**
 * A fresh set of ten, replacing every previous code, used or not. Needs a fresh
 * step-up on this session: printing new codes is as good as holding the
 * factor, so it is guarded like a write.
 */
export async function regenerateRecoveryCodes(
  caller: MfaCaller,
  now: Date = new Date(),
): Promise<{ recoveryCodes: string[] }> {
  const userSessionId = requireSession(caller);

  return runAsSuperuser(async (db) => {
    const session = await db.userSession.findFirst({
      where: { id: userSessionId, userId: caller.userId, revokedAt: null, expiresAt: { gt: now } },
      select: { mfaVerifiedAt: true, user: { select: { mfaEnabledAt: true } } },
    });
    // `?.user?.`: a user deleted between Prisma's two selects reads as null (#419).
    if (!session?.user?.mfaEnabledAt) throw new MfaEnrolmentRequiredError();
    if (!isStepUpFresh(session.mfaVerifiedAt, now)) throw new PlatformStepUpRequiredError();

    const recoveryCodes = await issueRecoveryCodes(db, caller.userId);
    await record(db, caller, MFA_EVENTS.RECOVERY_CODES_REGENERATED, {
      recoveryCodesIssued: recoveryCodes.length,
    });
    return { recoveryCodes };
  });
}
