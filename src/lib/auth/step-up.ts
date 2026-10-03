import type { PrismaClient } from '@prisma/client';

import { MfaEnrolmentRequiredError, PlatformStepUpRequiredError } from '@/lib/auth/mfa-errors';
import { MFA_STEP_UP_WINDOW_SECONDS } from '@/lib/platform/capabilities';

/**
 * Is THIS session stepped up, right now? The question every cross-club write
 * asks before it may run (#262).
 *
 * ═══ IN THE CALLER'S TRANSACTION, FROM THE SESSION ROW ═══
 *
 * `runAsPlatformAdmin` calls this with its own transaction handle, after the
 * attribution GUC is set and BEFORE the audit row and the work. So:
 *
 *   - the answer comes from `user_session.mfaVerifiedAt`, never a token claim.
 *     A claim cannot be revoked; this row can, and revoking it (sign-out,
 *     password change, sign-out-everywhere) ends the step-up in the same
 *     breath, because the row stops matching `revokedAt: null`;
 *   - it is keyed on (session id, user id). The session id comes from a JWT
 *     whose embedded secret `checkSession` has already matched against this
 *     row's hash, so a caller cannot name somebody else's stepped-up session;
 *     and the user id must match the actor, so a session cannot lend its
 *     step-up to another account;
 *   - a refusal throws inside the transaction, so it leaves no audit row
 *     claiming an action that never ran.
 *
 * ═══ ENROLMENT IS CHECKED HERE TOO ═══
 *
 * An account whose second factor was RESET by an operator still has sessions
 * whose `mfaVerifiedAt` is recent. Requiring `mfaEnabledAt` as well means a
 * reset takes effect at once rather than when the window happens to close.
 * (The runbook's reset also clears the column on every session, so this is
 * the second of two locks, not the only one.)
 */
export async function assertFreshStepUp(
  db: PrismaClient,
  input: { userId: string; userSessionId: string | null | undefined },
  now: Date = new Date(),
): Promise<void> {
  if (!input.userSessionId) throw new PlatformStepUpRequiredError();

  const row = await db.userSession.findFirst({
    where: {
      id: input.userSessionId,
      userId: input.userId,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: { mfaVerifiedAt: true, user: { select: { mfaEnabledAt: true } } },
  });

  // No such live session for this actor. Same answer as "not stepped up": the
  // remedy is the same, and naming the difference would describe our session
  // table to whoever is probing it.
  if (!row) throw new PlatformStepUpRequiredError();
  if (!row.user.mfaEnabledAt) throw new MfaEnrolmentRequiredError();
  if (!isStepUpFresh(row.mfaVerifiedAt, now)) throw new PlatformStepUpRequiredError();
}

/** How far "from the future" a step-up may be and still count: instance clock skew. */
const MAX_CLOCK_SKEW_MS = 60_000;

/** Pure, so the window boundary is testable without a database. */
export function isStepUpFresh(verifiedAt: Date | null, now: Date): boolean {
  if (!verifiedAt) return false;
  const age = now.getTime() - verifiedAt.getTime();
  // Written by one app instance and read by another, so a little skew is
  // normal; more than a minute "from the future" is a clock problem, not a
  // proof. Exactly at the window's end is expired — the direction that grants
  // less.
  return age > -MAX_CLOCK_SKEW_MS && age < MFA_STEP_UP_WINDOW_SECONDS * 1000;
}

/** When a step-up made at `verifiedAt` stops counting. */
export function stepUpExpiresAt(verifiedAt: Date | null): Date | null {
  return verifiedAt ? new Date(verifiedAt.getTime() + MFA_STEP_UP_WINDOW_SECONDS * 1000) : null;
}
