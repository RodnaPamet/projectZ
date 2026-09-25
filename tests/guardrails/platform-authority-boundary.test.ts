import { globSync, readFileSync } from 'node:fs';

import { PlatformCapability, Role } from '@prisma/client';

import { PERMISSIONS } from '@/lib/permissions';
import { ENTRA_MAPPABLE_ROLES } from '@/app-layer/schemas/entra-group-mapping';
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
    // P27 defends OWNER against Entra group mapping with
    // `CHECK (role <> 'OWNER')` — a DENYLIST. A new `ADMIN` value would be
    // ACCEPTED by that constraint, so the documented four-layer defence around
    // the most privileged role would silently become three for the MOST
    // privileged value of all.
    //
    // That asymmetry is the single sharpest reason platform authority is a
    // separate table, and it is invisible unless somebody goes looking.
    expect(Object.values(Role).sort()).toEqual(['COACH', 'MANAGER', 'OWNER', 'PLAYER', 'STAFF']);
  });

  it('no Role value names platform or admin authority', () => {
    const suspicious = Object.values(Role).filter((r) => /ADMIN|PLATFORM|SUPER|ROOT/.test(r));

    expect(suspicious).toEqual([]);
  });
});

describe('Entra cannot mint platform authority', () => {
  /** Every file that participates in directory sign-in or group mapping. */
  const ENTRA_FILES = [
    ...globSync('src/lib/auth/entra-*.ts').map((f) => f.toString()),
    'src/app-layer/usecases/entra-group-mappings.ts',
    'src/app-layer/schemas/entra-group-mapping.ts',
  ];

  it('the scan found the Entra code paths', () => {
    // A renamed file must not make this suite quietly stop checking.
    expect(ENTRA_FILES.length).toBeGreaterThanOrEqual(5);
    for (const f of ENTRA_FILES) {
      expect(() => readFileSync(f, 'utf8')).not.toThrow();
    }
  });

  it('OWNER is not mappable from a directory group', () => {
    // The existing rule, pinned here because everything below reasons from it:
    // a directory edit must not be able to mint a club owner.
    expect([...ENTRA_MAPPABLE_ROLES].sort()).toEqual(['COACH', 'MANAGER', 'PLAYER', 'STAFF']);
    expect(ENTRA_MAPPABLE_ROLES as readonly string[]).not.toContain('OWNER');
  });

  it('no Entra code path mentions the grant table or a platform capability', () => {
    // ═══ THE ARGUMENT, SO A FUTURE READER CAN DISAGREE ON PURPOSE ═══
    //
    // Everything that makes OWNER non-mappable applies more strongly to a
    // platform superuser:
    //
    //   blast radius   a mapped OWNER gets one club; a mapped platform admin
    //                  gets every club
    //   two-party      `platform_admin_grant_no_self_grant` makes the first
    //                  grant two-party. Someone who can edit their own group
    //                  membership could then grant themselves platform
    //                  authority ALONE, which is what that CHECK exists to stop
    //   grant path     a directory group IS an in-app grant path, with the
    //                  decision moved to whoever administers Entra — and the
    //                  owner chose CLI-only granting precisely so a stolen
    //                  session cannot mint a peer
    //   expiry         a grant expires at 90 days; group membership does not,
    //                  so a re-sync would re-grant and the cap becomes decor
    //   attribution    every grant records `grantedByUserId`, a person who can
    //                  be asked. A group sync has no such person.
    //
    // If that decision is ever reversed it should be reversed HERE, with the
    // trade written down — not by a line appearing in a sync function.
    const forbidden = /platform_admin_grant|platformAdminGrant|PlatformCapability|appPermissions/;
    const violations: string[] = [];

    for (const file of ENTRA_FILES) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const t = line.trim();
          // A comment explaining WHY Entra stays away from platform authority is
          // exactly what should be there.
          if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
          if (forbidden.test(line)) violations.push(`${file}:${i + 1}: ${t}`);
        });
    }

    if (violations.length > 0) {
      throw new Error(
        `Entra code paths must not reach platform authority:\n\n` +
          violations.map((v) => `  ${v}`).join('\n') +
          `\n\nA directory group that can grant platform authority defeats four separate\n` +
          `controls at once: the no-self-grant CHECK, the 90-day expiry, the absence of\n` +
          `an in-app grant path, and the record of which PERSON issued it.\n\n` +
          `If this is deliberate, say so in the PR and change the assertion — the\n` +
          `reasoning is in the comment above so it can be argued with.`,
      );
    }
  });

  // ── Negative control ───────────────────────────────────────────────
  it('the detector fires on the code it forbids', () => {
    // Passing by finding nothing is indistinguishable from a regex that matches
    // nothing, which is what this becomes the day somebody simplifies it.
    const forbidden = /platform_admin_grant|platformAdminGrant|PlatformCapability|appPermissions/;

    expect(forbidden.test('await tx.platformAdminGrant.create({ data });')).toBe(true);
    expect(forbidden.test('INSERT INTO platform_admin_grant (id) VALUES ($1)')).toBe(true);
    expect(forbidden.test("ctx.appPermissions.push('TENANT_READ');")).toBe(true);
    expect(forbidden.test('const c: PlatformCapability = x;')).toBe(true);

    // …and not on the tenant mapping this code is legitimately for.
    expect(forbidden.test('await tx.tenantEntraGroupMapping.create({ data });')).toBe(false);
    expect(forbidden.test("role: 'MANAGER',")).toBe(false);
  });
});
