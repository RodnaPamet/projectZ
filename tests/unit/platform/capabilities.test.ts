import { PlatformCapability } from '@prisma/client';

import * as capabilities from '@/lib/platform/capabilities';
import {
  grantAllows,
  isRefusedWrite,
  isWriteCapability,
  liveCapabilities,
  MFA_STEP_UP_WINDOW_SECONDS,
  PLATFORM_CAPABILITIES,
  PLATFORM_WRITE_CAPABILITIES,
  requiresStepUp,
  STEP_UP_PLATFORM_WRITES,
  type PlatformGrantSnapshot,
} from '@/lib/platform/capabilities';

/**
 * EXPIRY IS THE POINT OF THE WHOLE GRANT MODEL, SO IT IS TESTED HERE.
 *
 * `expiresAt` is NOT NULL with a 90-day CHECK in the database precisely so
 * "admin for ever" is not expressible. That guarantee is worth nothing if the
 * application never checks it — and an expiry exercised only against a real
 * Postgres is one nobody runs locally.
 *
 * `liveCapabilities` takes `now` explicitly for exactly this reason: the
 * boundary cases below need no clock faking and no database.
 */

const BASE: PlatformGrantSnapshot = {
  id: 'g1',
  capabilities: [PlatformCapability.TENANT_READ, PlatformCapability.AUDIT_READ],
  expiresAt: new Date('2026-10-01T00:00:00Z'),
  revokedAt: null,
};

const BEFORE = new Date('2026-09-25T00:00:00Z');
const AFTER = new Date('2026-10-02T00:00:00Z');
const EXACTLY = new Date('2026-10-01T00:00:00Z');

describe('liveCapabilities', () => {
  it('returns the capabilities of a live grant', () => {
    expect(liveCapabilities(BASE, BEFORE)).toEqual([
      PlatformCapability.TENANT_READ,
      PlatformCapability.AUDIT_READ,
    ]);
  });

  it('returns nothing when there is no grant', () => {
    // The overwhelmingly common case — almost nobody holds a grant. It must be
    // an empty list rather than a throw, because "not a platform admin" is an
    // ordinary 403, not an error condition.
    expect(liveCapabilities(null, BEFORE)).toEqual([]);
    expect(liveCapabilities(undefined, BEFORE)).toEqual([]);
  });

  it('returns nothing once revoked, even before expiry', () => {
    // Revocation is the fast path that matters during an incident. If this read
    // the expiry first, a revoked grant would keep working until it lapsed.
    const revoked = { ...BASE, revokedAt: new Date('2026-09-20T00:00:00Z') };
    expect(liveCapabilities(revoked, BEFORE)).toEqual([]);
  });

  it('returns nothing after expiry, even though nothing revoked it', () => {
    // The whole reason the column is NOT NULL: nobody goes back to revoke, so
    // expiry has to do the work unattended.
    expect(liveCapabilities(BASE, AFTER)).toEqual([]);
  });

  it('treats a grant expiring exactly now as expired', () => {
    // The boundary is arbitrary and therefore must be decided and pinned. The
    // safe direction is the one that grants less.
    expect(liveCapabilities(BASE, EXACTLY)).toEqual([]);
  });

  it('does not treat an empty capability list as a live grant with powers', () => {
    // The database refuses an empty array (`cardinality >= 1`), so this should
    // be unreachable. Asserted anyway: if that CHECK were ever dropped, the
    // failure here should be "permits nothing", never "permits everything".
    expect(liveCapabilities({ ...BASE, capabilities: [] }, BEFORE)).toEqual([]);
  });
});

describe('grantAllows', () => {
  it('is true only for a capability the live grant carries', () => {
    expect(grantAllows(BASE, PlatformCapability.TENANT_READ, BEFORE)).toBe(true);
    expect(grantAllows(BASE, PlatformCapability.USER_READ, BEFORE)).toBe(false);
  });

  it('is false for every capability once the grant lapses', () => {
    for (const capability of PLATFORM_CAPABILITIES) {
      expect(grantAllows(BASE, capability, AFTER)).toBe(false);
    }
  });

  it('is false for every capability when there is no grant', () => {
    for (const capability of PLATFORM_CAPABILITIES) {
      expect(grantAllows(null, capability, BEFORE)).toBe(false);
    }
  });
});

describe('the capability list', () => {
  it('matches the Postgres enum exactly', () => {
    // The enum is the source of truth. If a migration adds a value and this
    // tuple is not updated, code that iterates capabilities silently skips the
    // new one — including the write-refusal check below.
    expect([...PLATFORM_CAPABILITIES].sort()).toEqual(Object.values(PlatformCapability).sort());
  });

  it('classifies TENANT_SUSPEND and REVIEW_MODERATE as writes and the reads as reads', () => {
    expect(isWriteCapability(PlatformCapability.TENANT_SUSPEND)).toBe(true);
    // Enabled is not the same as "not a write". Relabelling it a read would
    // have enabled it too — by making the refusal a matter of naming.
    expect(isWriteCapability(PlatformCapability.REVIEW_MODERATE)).toBe(true);

    for (const read of [
      PlatformCapability.TENANT_READ,
      PlatformCapability.AUDIT_READ,
      PlatformCapability.USER_READ,
    ]) {
      expect(isWriteCapability(read)).toBe(false);
    }
  });

  it('keeps every write capability inside the refusal set', () => {
    // This is what makes "read-only at launch" data rather than a special case.
    // A second write capability added later inherits the refusal automatically,
    // instead of depending on somebody remembering to wire it.
    //
    // Named explicitly: anything whose name implies mutation must be in the set.
    const mutating = PLATFORM_CAPABILITIES.filter((c) =>
      /SUSPEND|WRITE|DELETE|CREATE|UPDATE|MANAGE|GRANT|MODERATE/.test(c),
    );

    expect(mutating.length).toBeGreaterThan(1);
    for (const c of mutating) {
      expect(PLATFORM_WRITE_CAPABILITIES.has(c)).toBe(true);
    }
  });
});

describe('which writes the binding refuses', () => {
  it('enables exactly one write, by name — REVIEW_MODERATE, behind a step-up', () => {
    // Pinned so enabling a second cross-club write is an edit to THIS file as
    // well as to the set, and a reviewer sees both. The terms REVIEW_MODERATE
    // is enabled on are written beside STEP_UP_PLATFORM_WRITES.
    expect([...STEP_UP_PLATFORM_WRITES]).toEqual([PlatformCapability.REVIEW_MODERATE]);
  });

  it('still refuses TENANT_SUSPEND', () => {
    expect(isRefusedWrite(PlatformCapability.TENANT_SUSPEND)).toBe(true);
  });

  it('refuses no read and not the enabled write', () => {
    expect(isRefusedWrite(PlatformCapability.REVIEW_MODERATE)).toBe(false);
    for (const read of [
      PlatformCapability.TENANT_READ,
      PlatformCapability.AUDIT_READ,
      PlatformCapability.USER_READ,
    ]) {
      expect(isRefusedWrite(read)).toBe(false);
    }
  });

  it('can only enable something that is a write', () => {
    // An entry here that is not in the write set would read as "enabled" while
    // meaning nothing — the kind of line that survives because it looks safe.
    for (const c of STEP_UP_PLATFORM_WRITES) {
      expect(PLATFORM_WRITE_CAPABILITIES.has(c)).toBe(true);
    }
  });

  it('refuses every write that is not enabled by name — the default stays refusal', () => {
    const refused = [...PLATFORM_WRITE_CAPABILITIES].filter((c) => !STEP_UP_PLATFORM_WRITES.has(c));
    expect(refused.length).toBeGreaterThan(0);
    for (const c of refused) expect(isRefusedWrite(c)).toBe(true);
  });
});

describe('the second factor (#262)', () => {
  it('EVERY write needs a step-up, and no read does — there is no exception left', () => {
    // The REVIEW_MODERATE exception (#228) is over. This is the assertion that
    // keeps it over: a write capability that does not require a step-up is not
    // expressible, because `requiresStepUp` is keyed on the write set itself.
    for (const c of PLATFORM_CAPABILITIES) {
      expect(requiresStepUp(c)).toBe(isWriteCapability(c));
    }
    expect(requiresStepUp(PlatformCapability.REVIEW_MODERATE)).toBe(true);
  });

  it('the "writes without a second factor" allowlist is gone, not merely emptied', () => {
    // An empty exception list is an invitation to add an entry back. The name
    // must not exist at all, so a revert has to reintroduce it on purpose.
    expect('ENABLED_PLATFORM_WRITES' in capabilities).toBe(false);
  });

  it('the step-up window is fifteen minutes', () => {
    // Pinned: widening it is a security decision that should show up as a test
    // change in review, not as one constant edited in passing.
    expect(MFA_STEP_UP_WINDOW_SECONDS).toBe(15 * 60);
  });
});
