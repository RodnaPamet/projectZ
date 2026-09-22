import {
  checkInviteCarveout,
  checkPublicRoute,
  checkTenantAccess,
  tenantSlugFromPath,
  type TokenClaims,
} from '@/lib/auth/guard';

const member = (slug: string): TokenClaims => ({
  sub: 'u1',
  memberships: [{ tenantSlug: slug, role: 'PLAYER' }],
});

describe('checkTenantAccess', () => {
  it('allows a member into their own tenant', () => {
    expect(checkTenantAccess('/t/sofia-padel/dashboard', member('sofia-padel'))).toEqual({
      kind: 'allow',
    });
  });

  it('DENIES a member of tenant A asking for tenant B', () => {
    // The whole point of the file.
    expect(checkTenantAccess('/t/plovdiv-tennis/dashboard', member('sofia-padel'))).toEqual({
      kind: 'forbidden',
      reason: 'not_a_member',
    });
  });

  it('denies the API route just as hard as the page route', () => {
    // A guard that only covers /t/** and forgets /api/t/** protects the
    // page and leaves the data wide open.
    expect(checkTenantAccess('/api/t/plovdiv-tennis/bookings', member('sofia-padel')).kind).toBe(
      'forbidden',
    );
  });

  it('does not distinguish "no such tenant" from "not a member"', () => {
    // Different answers here would be a tenant-enumeration oracle.
    const nonexistent = checkTenantAccess('/t/does-not-exist/x', member('sofia-padel'));
    const realButForeign = checkTenantAccess('/t/plovdiv-tennis/x', member('sofia-padel'));
    expect(nonexistent).toEqual(realButForeign);
  });

  it('reports unauthenticated (not forbidden) when there is no token', () => {
    expect(checkTenantAccess('/t/sofia-padel/dashboard', null).kind).toBe('unauthenticated');
  });

  it('a token with NO memberships cannot reach any tenant', () => {
    expect(checkTenantAccess('/t/sofia-padel/x', { sub: 'u1', memberships: [] }).kind).toBe(
      'forbidden',
    );
  });

  it('a slug that merely PREFIXES a real one is not a match', () => {
    // `sofia` must not open `sofia-padel`.
    expect(checkTenantAccess('/t/sofia-padel/x', member('sofia')).kind).toBe('forbidden');
  });
});

describe('public routes', () => {
  it.each(['/', '/venues', '/venues/sofia-padel', '/open-play', '/coaches', '/api/venues'])(
    '%s is public',
    (p) => {
      expect(checkPublicRoute(p)).toBe(true);
      expect(checkTenantAccess(p, null).kind).toBe('public');
    },
  );

  it('a tenant route is NOT public', () => {
    expect(checkPublicRoute('/t/sofia-padel/dashboard')).toBe(false);
  });
});

describe('invite carve-out', () => {
  it('an invite link works for someone who is not yet a member', () => {
    // By definition the invitee has no membership for this tenant. Without
    // the carve-out, the invite link is unusable by exactly the person it
    // was sent to.
    expect(checkInviteCarveout('/invite/abc123')).toBe(true);
    expect(checkTenantAccess('/invite/abc123', null).kind).toBe('public');
    expect(checkTenantAccess('/api/invites/abc123/redeem', null).kind).toBe('public');
  });

  it('the carve-out does NOT open the rest of the tenant', () => {
    // A carve-out that leaked would be worse than no invites at all.
    expect(checkInviteCarveout('/t/sofia-padel/admin')).toBe(false);
    expect(checkInviteCarveout('/api/t/sofia-padel/bookings')).toBe(false);
  });
});

describe('tenantSlugFromPath', () => {
  it.each([
    ['/t/sofia-padel/dashboard', 'sofia-padel'],
    ['/api/t/sofia-padel/bookings', 'sofia-padel'],
    ['/api/v1/t/sofia-padel/bookings', 'sofia-padel'],
    ['/api/v27/t/sofia-padel/bookings', 'sofia-padel'],
    ['/venues', null],
    // No tenant segment at all — `/v1` is not a slug.
    ['/api/v1/venues', null],
    // A non-numeric version is not a version. Better to fail closed on an
    // unrecognised shape than to invent a tenant from `/api/vNEXT/t/...`.
    ['/api/vnext/t/sofia-padel/bookings', null],
  ])('%s -> %s', (path, expected) => {
    expect(tenantSlugFromPath(path)).toBe(expected);
  });

  it('an unrecognised tenant URL shape is UNGUARDED, not merely unmatched', () => {
    // This is the whole reason the version group exists. `checkTenantAccess`
    // reads "no slug in the path" as `allow` — so a tenant route this
    // matcher does not recognise sails past the edge guard entirely, and
    // `requiredPermission` goes quiet for the same reason at the same time.
    //
    // Pinned as an assertion rather than a comment so the failure mode is
    // visible to whoever next adds a URL shape.
    expect(tenantSlugFromPath('/api/v2/t/sofia-padel/admin/venues')).toBe('sofia-padel');
    expect(checkTenantAccess('/api/v2/t/sofia-padel/admin/venues', member('other-club'))).toEqual({
      kind: 'forbidden',
      reason: 'not_a_member',
    });
  });

  it('a versioned tenant route is still denied to an anonymous caller', () => {
    expect(checkTenantAccess('/api/v1/t/sofia-padel/bookings', null)).toEqual({
      kind: 'unauthenticated',
    });
  });

  it('a member of the versioned tenant route is allowed', () => {
    expect(checkTenantAccess('/api/v1/t/sofia-padel/bookings', member('sofia-padel'))).toEqual({
      kind: 'allow',
    });
  });
});
