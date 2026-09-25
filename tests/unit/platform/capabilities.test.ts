import { PlatformCapability } from '@prisma/client';

import {
  grantAllows,
  isWriteCapability,
  liveCapabilities,
  PLATFORM_CAPABILITIES,
  PLATFORM_WRITE_CAPABILITIES,
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

  it('classifies TENANT_SUSPEND as a write and the reads as reads', () => {
    expect(isWriteCapability(PlatformCapability.TENANT_SUSPEND)).toBe(true);

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
      /SUSPEND|WRITE|DELETE|CREATE|UPDATE|MANAGE|GRANT/.test(c),
    );

    expect(mutating.length).toBeGreaterThan(0);
    for (const c of mutating) {
      expect(PLATFORM_WRITE_CAPABILITIES.has(c)).toBe(true);
    }
  });
});
