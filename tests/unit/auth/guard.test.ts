import {
  checkInviteCarveout,
  checkPublicRoute,
  checkTenantAccess,
  permissionsForPath,
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

  it('does NOT conclude that a member of tenant A is a stranger at tenant B (#250)', () => {
    // It used to: `forbidden`, the whole point of the file. But a web token
    // lists only the clubs held at sign-in, and #229 joins a player to a club
    // by booking — so B may be theirs since this afternoon. The edge cannot
    // read the database, so it hands the question to the route, which can.
    expect(checkTenantAccess('/t/plovdiv-tennis/dashboard', member('sofia-padel'))).toEqual({
      kind: 'needs_db_check',
      tenantSlug: 'plovdiv-tennis',
    });
  });

  it('defers the API route exactly as it defers the page route', () => {
    // Both have a database-backed decider behind them: `contextFromRequest`
    // for the API, `resolveTenantPageContext` for pages and Server Actions.
    expect(checkTenantAccess('/api/t/plovdiv-tennis/bookings', member('sofia-padel')).kind).toBe(
      'needs_db_check',
    );
    expect(checkTenantAccess('/api/v1/t/plovdiv-tennis/bookings', member('sofia-padel')).kind).toBe(
      'needs_db_check',
    );
  });

  it('does not distinguish "no such tenant" from "not a member"', () => {
    // Different answers here would be a tenant-enumeration oracle. They are
    // identical here — both undecided — and the route resolves both from the
    // same query, as "no membership at this slug".
    const nonexistent = checkTenantAccess('/t/does-not-exist/x', member('sofia-padel'));
    const realButForeign = checkTenantAccess('/t/plovdiv-tennis/x', member('sofia-padel'));
    expect(nonexistent.kind).toBe(realButForeign.kind);
    expect(nonexistent.kind).toBe('needs_db_check');
  });

  it('reports unauthenticated (not forbidden) when there is no token', () => {
    expect(checkTenantAccess('/t/sofia-padel/dashboard', null).kind).toBe('unauthenticated');
  });

  it('still refuses a token with no subject, whatever it lists', () => {
    // The one decision the edge can still make alone: nobody is signed in.
    expect(
      checkTenantAccess('/api/v1/t/sofia-padel/bookings', {
        memberships: [{ tenantSlug: 'sofia-padel', role: 'OWNER' }],
      }).kind,
    ).toBe('unauthenticated');
  });

  it('a NATIVE token — no memberships claim at all — is deferred at its own club (#250)', () => {
    // `mintAccessToken` writes {sub, userSessionId, sessionVersion}. The edge
    // used to read the missing claim as "not a member" and 403 every tenant
    // route of the iOS client. Measured on main:
    //   {"kind":"forbidden","reason":"not_a_member"}
    const native = { sub: 'u1', userSessionId: 's1', sessionVersion: 0 } as TokenClaims;
    expect(checkTenantAccess('/api/v1/t/sofia-padel/bookings', native)).toEqual({
      kind: 'needs_db_check',
      tenantSlug: 'sofia-padel',
    });
  });

  it('an EMPTY list defers too — it is what a first sign-in carries', () => {
    expect(checkTenantAccess('/t/sofia-padel/x', { sub: 'u1', memberships: [] }).kind).toBe(
      'needs_db_check',
    );
  });

  it('a slug that merely PREFIXES a real one is not a match', () => {
    // `sofia` must not open `sofia-padel` on the fast path. It is undecided,
    // not allowed — and it grants nothing at the edge's permission check.
    expect(checkTenantAccess('/t/sofia-padel/x', member('sofia')).kind).toBe('needs_db_check');
    expect(permissionsForPath('/api/t/sofia-padel/admin/venues', member('sofia'))).toEqual([]);
  });
});

describe('the platform tree', () => {
  /**
   * ═══ WHY THIS BRANCH EXISTS AT ALL ═══
   *
   * `/api/v1/platform/**` carries no tenant slug. Without an explicit branch it
   * falls into `if (!slug) return allow` — which sits BEFORE the token check —
   * so an anonymous request reaches the route.
   *
   * It still failed closed there: `asPlatformAdmin` throws without a grant. The
   * branch buys a 401 instead of a 403, and it avoids burning a database query
   * per anonymous probe, since `resolvePlatformAuthority` reads the grant table.
   *
   * Moving the branch BELOW the slug check breaks the anonymous case, and the
   * assertion for it fails. Moving it ABOVE the public-route check breaks
   * nothing today — no public route lives under this prefix — so the last test
   * pins the ordering as a fact rather than pretending to detect it.
   */

  // Someone signed in with no club at all — the ordinary shape of a platform
  // admin, who is deliberately not a member of the clubs they administer.
  const signedIn: TokenClaims = { sub: 'admin-1', memberships: [] };

  it('lets a signed-in caller through to the route, which does the real check', () => {
    // 'allow' here is not authorisation. The grant is read per request inside
    // the route, from the database, because a token claim goes stale and
    // revocation has to bite on the next request.
    expect(checkTenantAccess('/api/v1/platform/tenants', signedIn)).toEqual({ kind: 'allow' });
    expect(checkTenantAccess('/api/v1/platform/audit', signedIn)).toEqual({ kind: 'allow' });
  });

  it('401s an anonymous caller instead of letting the route answer', () => {
    // The regression this guards: without the branch, `!slug` allows it.
    expect(checkTenantAccess('/api/v1/platform/tenants', null).kind).toBe('unauthenticated');
    expect(checkTenantAccess('/api/v1/platform/audit', null).kind).toBe('unauthenticated');
  });

  it('does not require a membership, which a platform admin will not have', () => {
    // A token with zero memberships is undecided at every /t/** path — the
    // route asks the database — and is simply allowed into the platform tree,
    // where the grant is read per request.
    expect(checkTenantAccess('/t/sofia-padel/x', signedIn).kind).toBe('needs_db_check');
    expect(checkTenantAccess('/api/v1/platform/tenants', signedIn).kind).toBe('allow');
  });

  it('matches the tree, not merely the word "platform"', () => {
    // The prefix ends in a slash on purpose. `/api/v1/platformish/...` is not
    // the platform tree, and a tenant path that happens to contain the word is
    // still tenant-scoped.
    expect(checkTenantAccess('/api/v1/platformish/x', null).kind).not.toBe('unauthenticated');
    expect(checkTenantAccess('/t/platform-padel/x', member('sofia-padel')).kind).toBe(
      'needs_db_check',
    );
  });

  it('is not a public route, and the public check still runs first', () => {
    // NOT a detector: with nothing public under the prefix, moving the branch
    // above the public check would change no behaviour and this would still
    // pass. It records the two facts the ordering rests on, so that the day
    // something public IS added under /api/v1/platform/, whoever adds it finds
    // the assumption written down instead of discovering it.
    expect(checkPublicRoute('/api/v1/platform/tenants')).toBe(false);
    expect(checkTenantAccess('/venues', null).kind).toBe('public');
  });
});

describe('public routes', () => {
  it.each([
    '/',
    '/venues',
    '/venues/sofia-padel',
    '/clubs/sofia-padel',
    '/open-play',
    '/coaches',
    '/api/venues',
  ])('%s is public', (p) => {
    expect(checkPublicRoute(p)).toBe(true);
    expect(checkTenantAccess(p, null).kind).toBe('public');
  });

  it('a tenant route is NOT public', () => {
    expect(checkPublicRoute('/t/sofia-padel/dashboard')).toBe(false);
  });

  it('the club page prefix opens no lookalike (#356)', () => {
    expect(checkPublicRoute('/clubsecrets')).toBe(false);
    expect(checkPublicRoute('/t/clubs')).toBe(false);
  });
});

describe('the v1 public reads', () => {
  /**
   * These were public only because `checkTenantAccess` finds no slug in them
   * and falls through to `allow` — the fail-open default this file tightens
   * everywhere else and warns about by name for `/login`.
   *
   * `tests/guardrails/public-routes-match-the-spec.test.ts` holds the SET in
   * agreement with `security: []` in the OpenAPI document. What is here is the
   * prefix arithmetic, which the spec cannot express.
   */
  it.each([
    '/api/v1/venues',
    '/api/v1/venues/near',
    '/api/v1/venues/cvenue123',
    '/api/v1/venues/cvenue123/availability',
    '/api/v1/realtime/subscribe',
  ])('%s is public, not merely reachable', (path) => {
    expect(checkPublicRoute(path)).toBe(true);
    expect(checkTenantAccess(path, null).kind).toBe('public');
  });

  it('the prefix stops at a path segment', () => {
    // `/^\/api\/v1\/venues(\/|$)/` must not open `/api/v1/venuesecrets`.
    // Bare `startsWith` would, and that is the classic way a prefix list grows
    // a hole nobody sees.
    expect(checkPublicRoute('/api/v1/venuesecrets')).toBe(false);
    expect(checkPublicRoute('/api/v1/venues-admin')).toBe(false);
  });

  it('the realtime pattern opens the callback and nothing else under it', () => {
    // Anchored with `$` on purpose: `/realtime/token` mints a connection token
    // for a signed-in user and must NOT be public.
    expect(checkPublicRoute('/api/v1/realtime/subscribe')).toBe(true);
    expect(checkPublicRoute('/api/v1/realtime/token')).toBe(false);
    expect(checkPublicRoute('/api/v1/realtime/subscribe/extra')).toBe(false);
  });

  it('does not open the tenant tree, which shares no prefix by accident', () => {
    expect(checkPublicRoute('/api/v1/t/sofia-padel/bookings')).toBe(false);
    expect(checkTenantAccess('/api/v1/t/sofia-padel/bookings', null).kind).toBe('unauthenticated');
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
    // Recognised, so NOT the fail-open `allow`: anonymous is refused and a
    // signed-in caller is handed to a route that must resolve the membership.
    expect(checkTenantAccess('/api/v2/t/sofia-padel/admin/venues', null).kind).toBe(
      'unauthenticated',
    );
    expect(checkTenantAccess('/api/v2/t/sofia-padel/admin/venues', member('other-club'))).toEqual({
      kind: 'needs_db_check',
      tenantSlug: 'sofia-padel',
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

describe('permissionsForPath', () => {
  /**
   * An OWNER at one club who is merely a PLAYER at another. This is not an
   * exotic shape — it is a club owner who also plays somewhere else, i.e.
   * most club owners.
   */
  const ownerAtSofiaPlayerAtPlovdiv: TokenClaims = {
    sub: 'u1',
    memberships: [
      { tenantSlug: 'sofia-padel', role: 'OWNER' },
      { tenantSlug: 'plovdiv-tennis', role: 'PLAYER' },
    ],
  };

  it('gives OWNER permissions at the club they own', () => {
    expect(
      permissionsForPath('/api/t/sofia-padel/admin/venues', ownerAtSofiaPlayerAtPlovdiv),
    ).toContain('admin.venue_manage');
  });

  it('DENIES those same permissions one path segment away', () => {
    // The bug, stated as a test. Same token, same request shape, different
    // slug — and the answer has to change, because the ROLE changed.
    const perms = permissionsForPath(
      '/api/t/plovdiv-tennis/admin/venues',
      ownerAtSofiaPlayerAtPlovdiv,
    );
    expect(perms).not.toContain('admin.venue_manage');
    expect(perms).toEqual(expect.arrayContaining(['bookings.create']));
  });

  it('does not read token.permissions, even when it disagrees', () => {
    // auth.ts mints `permissions` from memberships[0]. If this helper ever
    // falls back to that array, the escalation is back — so hand it a token
    // whose frozen array is maximally wrong and check it is ignored.
    const token = {
      ...ownerAtSofiaPlayerAtPlovdiv,
      permissions: ['admin.venue_manage', 'admin.tenant_lifecycle'],
      role: 'OWNER',
    } as TokenClaims;

    expect(permissionsForPath('/api/t/plovdiv-tennis/admin/venues', token)).not.toContain(
      'admin.venue_manage',
    );
  });

  it('is empty for a member of nothing, an anonymous caller, and a non-tenant path', () => {
    expect(
      permissionsForPath('/api/t/sofia-padel/admin/venues', { sub: 'u1', memberships: [] }),
    ).toEqual([]);
    expect(permissionsForPath('/api/t/sofia-padel/admin/venues', null)).toEqual([]);
    expect(permissionsForPath('/api/v1/auth/token', ownerAtSofiaPlayerAtPlovdiv)).toEqual([]);
  });

  it('is empty when the list was truncated and the slug is not in the visible part', () => {
    // What the TOKEN says, which is nothing. The middleware does not ask this
    // on `needs_db_check` since #250: the route checks the permission against
    // the database instead, so club 51 is no longer refused its mutations.
    expect(
      permissionsForPath('/api/t/club-51/admin/venues', {
        sub: 'u1',
        memberships: [{ tenantSlug: 'sofia-padel', role: 'OWNER' }],
        membershipsTruncated: true,
      }),
    ).toEqual([]);
  });

  it('an unknown role grants nothing rather than throwing', () => {
    // The claim is a string off a token. A role renamed in the schema must
    // degrade to "no permissions", not to a 500 at the edge.
    expect(
      permissionsForPath('/api/t/sofia-padel/admin/venues', {
        sub: 'u1',
        memberships: [{ tenantSlug: 'sofia-padel', role: 'ARCHDUKE' }],
      }),
    ).toEqual([]);
  });
});
