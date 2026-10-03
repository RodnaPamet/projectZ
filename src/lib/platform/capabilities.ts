import { PlatformCapability } from '@prisma/client';

/**
 * Platform capabilities — the only authority in this product that spans clubs.
 *
 * ═══ WHY THESE ARE NOT IN `src/lib/permissions.ts` ═══
 *
 * They must stay DISJOINT from the tenant `Permission` union, and not merely
 * by convention. `ROLE_PERMISSIONS` gives `OWNER: [...PERMISSIONS]` — every
 * permission in that list, spread. So a platform string added to `PERMISSIONS`
 * would be granted to every club owner in the same commit, silently, and the
 * permissions test would then require it to be.
 *
 * A separate module and a separate Postgres enum make that mistake a type
 * error rather than a privilege escalation.
 */

export { PlatformCapability };

/**
 * Every capability, as a tuple. The Postgres enum is the source of truth; this
 * exists so code can iterate and so the guardrail can assert the two agree.
 */
export const PLATFORM_CAPABILITIES = [
  PlatformCapability.TENANT_READ,
  PlatformCapability.AUDIT_READ,
  PlatformCapability.USER_READ,
  PlatformCapability.TENANT_SUSPEND,
  PlatformCapability.REVIEW_MODERATE,
] as const;

/**
 * Capabilities that WRITE across clubs.
 *
 * Every one of them needs a fresh second-factor step-up on the session that
 * asks (#262) — see `requiresStepUp` below. `TENANT_SUSPEND` is still declared
 * and NOT enabled at all: there is no route for it, and a guardrail asserts no
 * route asks for it. Having a second factor does not by itself make taking a
 * club offline a power worth shipping; that is a product decision of its own.
 *
 * This set is what makes both rules data rather than special cases — a write
 * capability added later inherits the step-up AND the refusal automatically,
 * instead of needing someone to remember either.
 */
export const PLATFORM_WRITE_CAPABILITIES: ReadonlySet<PlatformCapability> = new Set([
  PlatformCapability.TENANT_SUSPEND,
  PlatformCapability.REVIEW_MODERATE,
]);

/**
 * The cross-club writes that are ENABLED — each behind a step-up, by name.
 *
 * ═══ AN ALLOWLIST, SO REFUSAL STAYS THE DEFAULT ═══
 *
 * Every write stays a write, and the binding refuses every write that is not
 * also listed here. A write capability added tomorrow is refused until somebody
 * adds it to this set, with its reasons.
 *
 * ═══ THERE IS NO LONGER A WRITE WITHOUT A SECOND FACTOR ═══
 *
 * Until #262 this set was `ENABLED_PLATFORM_WRITES` and meant "admitted with no
 * second factor, because there was none": REVIEW_MODERATE was the one exception
 * (#228), on the terms that it deletes nothing and audits every decision. That
 * exception has ended. The set was renamed rather than emptied, because an
 * empty "writes without MFA" list is an invitation to add one back; there is
 * now no way to spell that at all. `requiresStepUp` is true for EVERY write,
 * and tests/unit/platform/capabilities.test.ts pins it.
 *
 * REVIEW_MODERATE is here because a club must not moderate reviews of itself,
 * and a queue nobody may act on holds every text review forever (#228). Its
 * reach is still one review's visibility, the case, and the venue rating
 * recomputed from them — and now a stolen moderator session can do none of it
 * without the moderator's phone.
 */
export const STEP_UP_PLATFORM_WRITES: ReadonlySet<PlatformCapability> = new Set([
  PlatformCapability.REVIEW_MODERATE,
]);

export function isWriteCapability(capability: PlatformCapability): boolean {
  return PLATFORM_WRITE_CAPABILITIES.has(capability);
}

/** A write the binding refuses outright: every write not enabled by name above. */
export function isRefusedWrite(capability: PlatformCapability): boolean {
  return isWriteCapability(capability) && !STEP_UP_PLATFORM_WRITES.has(capability);
}

/**
 * Whether exercising `capability` needs a fresh step-up on the session.
 *
 * Every write, without exception — the function exists so the binding asks a
 * question with a name rather than re-deriving it. It is keyed on the
 * CAPABILITY, like the refusal, not on the HTTP verb: the moderation queue's
 * read runs under REVIEW_MODERATE as well, because the capability that permits
 * the decision also permits seeing every club's held reviews, and a session
 * that cannot decide has no business paging through them either.
 */
export function requiresStepUp(capability: PlatformCapability): boolean {
  return isWriteCapability(capability);
}

/**
 * How long a step-up lasts: 15 minutes from the moment the code was accepted,
 * NOT sliding.
 *
 * ═══ WHY 15, AND WHY FIXED ═══
 *
 * The threat a step-up answers is a session used by somebody other than its
 * owner — a cookie lifted by malware or a hostile extension, a laptop left
 * unlocked, a native refresh token copied off a device. The session itself
 * lives for days (SESSION_MAX_AGE_SECONDS, 7) and a native refresh token for
 * 30; the step-up shrinks the part of that life in which the session can WRITE
 * across clubs to the minutes right after the owner proved they hold the phone.
 *
 * Fixed rather than sliding: a window that renews on use is renewed by the
 * attacker too, and turns one proof into a session-long one. Fifteen minutes
 * is the length of a sitting at the queue — a moderator approves or rejects a
 * batch, and types one code per batch — and short enough that a session
 * stolen afterwards finds the window already shut. GitHub's sudo mode is two
 * hours; this is a smaller population doing a narrower job, so it can afford a
 * tighter bound.
 *
 * Written and checked on the app clock, like every other expiry in this
 * codebase (Prisma stores `timestamp(3)` as UTC; mixing it with Postgres
 * `now()` would tie the window to the server's TimeZone setting). Instances
 * run NTP; `isStepUpFresh` tolerates a minute of skew in the "from the future"
 * direction only, so skew can never lengthen the window by more than that.
 */
export const MFA_STEP_UP_WINDOW_SECONDS = 15 * 60;

/**
 * A grant reduced to what an authorisation decision needs. Deliberately not the
 * Prisma row: `reason`, `grantedByUserId` and the revocation columns matter for
 * the audit trail, not for deciding whether this request may proceed.
 */
export interface PlatformGrantSnapshot {
  id: string;
  capabilities: readonly PlatformCapability[];
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * What a grant permits RIGHT NOW — the empty list unless it is live.
 *
 * Pure, and takes `now` explicitly, so expiry is testable without a database
 * and without faking the clock. That matters more than it looks: expiry is the
 * whole reason `expiresAt` is NOT NULL with a 90-day CHECK, and an expiry that
 * is only exercised against a real Postgres is one nobody tests at all.
 *
 * Three ways a grant is not live, and all three must return `[]` rather than
 * throwing — a lapsed grant is an ordinary 403, not an error condition:
 *
 *   - there is no grant
 *   - it was revoked
 *   - it has expired
 *
 * `expiresAt <= now` rather than `<`: a grant expiring exactly now has expired.
 * The boundary is arbitrary but it has to be decided somewhere, and the safe
 * direction is the one that grants less.
 */
export function liveCapabilities(
  grant: PlatformGrantSnapshot | null | undefined,
  now: Date,
): readonly PlatformCapability[] {
  if (!grant) return [];
  if (grant.revokedAt !== null) return [];
  if (grant.expiresAt.getTime() <= now.getTime()) return [];
  return grant.capabilities;
}

/** Whether a live grant carries a specific capability. */
export function grantAllows(
  grant: PlatformGrantSnapshot | null | undefined,
  capability: PlatformCapability,
  now: Date,
): boolean {
  return liveCapabilities(grant, now).includes(capability);
}
