import { PlatformCapability, Role } from '@prisma/client';

import { PERMISSIONS } from '@/lib/permissions';
import { PLATFORM_CAPABILITIES } from '@/lib/platform/capabilities';

/**
 * THE BOUNDARY AROUND CROSS-CLUB AUTHORITY, ASSERTED RATHER THAN ASSUMED.
 *
 * P31 made platform authority a row in `platform_admin_grant`, deliberately not
 * a value in `enum Role` and deliberately not a string in `PERMISSIONS`. Those
 * choices are load-bearing and each of them is one careless edit from being
 * undone, in ways that are invisible in review.
 *
 * Every assertion below is a specific mistake somebody could make next week.
 */

describe('platform capabilities never leak into tenant permissions', () => {
  it('the two sets do not intersect', () => {
    // ═══ WHY THIS IS THE MOST IMPORTANT ONE ═══
    //
    // `ROLE_PERMISSIONS` gives `OWNER: [...PERMISSIONS]` — every permission in
    // that list, spread. So a platform string added to PERMISSIONS would be
    // granted to EVERY CLUB OWNER in the same commit, silently, and
    // permissions.test.ts would then require it to be.
    //
    // A platform capability held by every club owner is the exact inverse of
    // what a platform capability is for.
    const overlap = (PERMISSIONS as readonly string[]).filter((p) =>
      (PLATFORM_CAPABILITIES as readonly string[]).includes(p),
    );

    expect(overlap).toEqual([]);
  });

  it('no tenant permission is namespaced as a platform one', () => {
    // The near-miss version: `platform.tenant_read` added to PERMISSIONS reads
    // like platform authority, would be spread into OWNER, and would satisfy
    // nothing in the platform path because `hasAppPermission` is typed to the
    // capability union. It would be a permission that looks powerful and does
    // nothing — until somebody "fixes" it by widening the union.
    const namespaced = (PERMISSIONS as readonly string[]).filter((p) => p.startsWith('platform.'));

    expect(namespaced).toEqual([]);
  });

  it('the two lists are both non-empty, so the checks above are not vacuous', () => {
    expect(PERMISSIONS.length).toBeGreaterThan(10);
    expect(PLATFORM_CAPABILITIES.length).toBeGreaterThan(0);
  });
});

describe('enum Role stays tenant-scoped', () => {
  it('has exactly the five tenant roles', () => {
    // ═══ WHY A VALUE ADDED HERE WOULD BE WORSE THAN IT LOOKS ═══
    //
    // P27 defended OWNER against Entra group mapping with
    // `CHECK (role <> 'OWNER')` — a DENYLIST. A new `ADMIN` value would be
    // ACCEPTED by that constraint, so the documented four-layer defence around
    // the most privileged role would silently have become three for the MOST
    // privileged value of all.
    //
    // That asymmetry was the sharpest reason platform authority is a separate
    // table. The group sync is gone (#361) and the constraint goes with its
    // table (#443); the rest of the reasoning — a `Role` is one club's role,
    // and platform authority is not one club's — stands without it.
    expect(Object.values(Role).sort()).toEqual(['COACH', 'MANAGER', 'OWNER', 'PLAYER', 'STAFF']);
  });

  it('no Role value names platform or admin authority', () => {
    const suspicious = Object.values(Role).filter((r) => /ADMIN|PLATFORM|SUPER|ROOT/.test(r));

    expect(suspicious).toEqual([]);
  });
});
