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
 * `TENANT_SUSPEND` is declared and deliberately NOT enabled. Stepping up to a
 * cross-club write should require a second factor, and there is none:
 * `User.mfaSecret` is unencrypted and nothing writes it. The binding throws
 * `PlatformWriteNotEnabledError` rather than shipping a power that cannot be
 * defended, and a guardrail asserts no route asks for it.
 *
 * This set is what makes that refusal data rather than a special case — adding
 * a second write capability later inherits the refusal automatically instead of
 * needing someone to remember. `REVIEW_MODERATE` is in it because it IS a
 * write; that it is also enabled is said separately, below, by name.
 */
export const PLATFORM_WRITE_CAPABILITIES: ReadonlySet<PlatformCapability> = new Set([
  PlatformCapability.TENANT_SUSPEND,
  PlatformCapability.REVIEW_MODERATE,
]);

/**
 * The cross-club writes that ARE enabled — named one at a time.
 *
 * ═══ AN ALLOWLIST, SO REFUSAL STAYS THE DEFAULT ═══
 *
 * Moving a write OUT of the set above would have been one line, and it would
 * have made "is this a write?" answer no for something that plainly is one —
 * the refusal would then be a property of how a capability was labelled rather
 * than of what it does. Instead every write stays a write, and the binding
 * refuses every write that is not also listed here. A write capability added
 * tomorrow is refused until somebody adds it to this set, with its reasons.
 *
 * ═══ WHY REVIEW_MODERATE, WITHOUT THE SECOND FACTOR ═══
 *
 * The owner's decision on #228: a club must not moderate reviews of itself, so
 * the queue is worked by platform moderators — and a queue nobody may act on
 * holds every text review forever, because without a classifier key every one
 * of them lands there. It is admitted on these terms, which are what separate
 * it from TENANT_SUSPEND:
 *
 *   reach     one review's visibility, the case that tracks it, and the venue
 *             rating recomputed from them. No money, no access, no club state.
 *   deletes   nothing. A rejected review keeps its text; the case keeps who
 *             decided and why.
 *   record    every decision writes a platform audit row first, with the
 *             moderator's own note as its reason, in the same transaction.
 *
 * What a stolen moderator session could do is publish held reviews or hide
 * published ones until the grant is revoked — visible, attributable, and
 * bounded by the grant's expiry. Taking a club offline is not in that class,
 * which is why TENANT_SUSPEND is not here.
 */
export const ENABLED_PLATFORM_WRITES: ReadonlySet<PlatformCapability> = new Set([
  PlatformCapability.REVIEW_MODERATE,
]);

export function isWriteCapability(capability: PlatformCapability): boolean {
  return PLATFORM_WRITE_CAPABILITIES.has(capability);
}

/** A write the binding refuses: every write, unless it is enabled by name above. */
export function isRefusedWrite(capability: PlatformCapability): boolean {
  return isWriteCapability(capability) && !ENABLED_PLATFORM_WRITES.has(capability);
}

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
