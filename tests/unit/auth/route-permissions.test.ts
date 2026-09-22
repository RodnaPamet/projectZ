import { getPermissionsForRole } from '@/lib/permissions';
import { ROUTE_PERMISSIONS, requiredPermission } from '@/lib/security/route-permissions';

describe('route permissions', () => {
  it('a refund requires payments.refund — NOT bookings.create', () => {
    // THE bug this table's ordering exists to prevent.
    //
    // `/bookings/:id/refund` also matches the `/bookings` pattern. If the
    // generic rule came first, a refund would only require
    // `bookings.create` — which every PLAYER has. Any player could refund
    // their own booking, and drain the club's Stripe balance.
    expect(requiredPermission('/api/t/sofia/bookings/bk_1/refund', 'POST')).toBe('payments.refund');
  });

  it('a cancel requires bookings.cancel, not bookings.create', () => {
    expect(requiredPermission('/api/t/sofia/bookings/bk_1/cancel', 'POST')).toBe('bookings.cancel');
  });

  it('creating a booking requires bookings.create', () => {
    expect(requiredPermission('/api/t/sofia/bookings', 'POST')).toBe('bookings.create');
  });

  it('a PLAYER cannot satisfy the refund route, but a MANAGER can', () => {
    const needed = requiredPermission('/api/t/sofia/bookings/bk_1/refund', 'POST')!;

    const player = getPermissionsForRole('PLAYER');
    const manager = getPermissionsForRole('MANAGER');

    expect(player).not.toContain(needed);
    expect(manager).toContain(needed);
  });

  it('a STAFF member can cancel but cannot refund', () => {
    const staff = getPermissionsForRole('STAFF');
    expect(staff).toContain(requiredPermission('/api/t/sofia/bookings/bk_1/cancel', 'POST')!);
    expect(staff).not.toContain(requiredPermission('/api/t/sofia/bookings/bk_1/refund', 'POST')!);
  });

  it.each([
    ['/api/t/sofia/admin/venues', 'POST', 'admin.venue_manage'],
    ['/api/t/sofia/admin/staff', 'DELETE', 'admin.staff_manage'],
    ['/api/t/sofia/admin/pricing', 'PUT', 'admin.pricing_manage'],
    ['/api/t/sofia/admin/courts', 'PATCH', 'courts.manage'],
    ['/api/t/sofia/players/p1/credit', 'POST', 'players.credit_adjust'],
    ['/api/t/sofia/sessions', 'POST', 'openplay.host'],
    ['/api/t/sofia/sessions/s1/moderate', 'DELETE', 'openplay.moderate'],
  ])('%s %s requires %s', (path, method, expected) => {
    expect(requiredPermission(path, method)).toBe(expected);
  });

  it('GET is not gated by these rules (reads are gated by RLS + route logic)', () => {
    expect(requiredPermission('/api/t/sofia/bookings', 'GET')).toBeNull();
  });

  it('every rule names a permission that actually exists for some role', () => {
    // A rule naming a permission no role holds is a route nobody can ever
    // call — a silent, permanent 403 that looks like "correctly secured".
    const allGranted = new Set(
      (['OWNER', 'MANAGER', 'STAFF', 'COACH', 'PLAYER'] as const).flatMap((r) => [
        ...getPermissionsForRole(r),
      ]),
    );

    for (const rule of ROUTE_PERMISSIONS) {
      expect(allGranted.has(rule.permission)).toBe(true);
    }
  });

  // ── Versioned API prefix ──────────────────────────────────────────
  //
  // These rules deny by MATCHING. A pattern that does not match returns
  // `null` from `requiredPermission`, and `middleware.ts` reads `null` as
  // "no permission required" — so a rule that misses `/api/v1` does not
  // half-protect the route, it leaves it open to every authenticated
  // member of the tenant, PLAYERs included.

  it.each([
    ['/api/v1/t/sofia/admin/venues', 'POST', 'admin.venue_manage'],
    ['/api/v1/t/sofia/admin/staff', 'DELETE', 'admin.staff_manage'],
    ['/api/v1/t/sofia/admin/pricing', 'PUT', 'admin.pricing_manage'],
    ['/api/v1/t/sofia/admin/courts', 'PATCH', 'courts.manage'],
    ['/api/v1/t/sofia/bookings', 'POST', 'bookings.create'],
    ['/api/v1/t/sofia/bookings/bk_1/cancel', 'POST', 'bookings.cancel'],
    ['/api/v1/t/sofia/bookings/bk_1/refund', 'POST', 'payments.refund'],
    ['/api/v1/t/sofia/players/p1/credit', 'POST', 'players.credit_adjust'],
    ['/api/v1/t/sofia/sessions', 'POST', 'openplay.host'],
    ['/api/v1/t/sofia/sessions/s1/moderate', 'DELETE', 'openplay.moderate'],
  ])('versioned %s %s still requires %s', (path, method, expected) => {
    expect(requiredPermission(path, method)).toBe(expected);
  });

  it('ordering survives the version prefix — a versioned refund is not bookings.create', () => {
    // The specific-before-generic ordering and the version group are
    // independent edits. This pins that they compose: widening the prefix
    // must not let `/bookings` win over `/bookings/:id/refund`.
    expect(requiredPermission('/api/v1/t/sofia/bookings/bk_1/refund', 'POST')).toBe(
      'payments.refund',
    );
  });

  it('EVERY rule carries the version group, including ones added later', () => {
    // The point of this test is the rules nobody has written yet. Adding a
    // literal `^/api/t/...` rule alongside the versioned ones is the natural
    // mistake: it looks exactly like its neighbours, reviews cleanly, and is
    // wrong only for URLs that do not exist yet. This fails when it lands,
    // not when someone finally calls the endpoint.
    const VERSIONED_TENANT_PREFIX = String.raw`^\/api\/(?:v\d+\/)?t\/`;

    for (const rule of ROUTE_PERMISSIONS) {
      // Compare the prefix as a string rather than testing a sample path —
      // a mismatch then prints both regexes, which is what you want when
      // one is a single character off.
      expect(rule.pattern.source.slice(0, VERSIONED_TENANT_PREFIX.length)).toBe(
        VERSIONED_TENANT_PREFIX,
      );
    }
  });

  it('a version segment does not smuggle past the tenant anchor', () => {
    // `/api/v1/admin/venues` has no tenant in it. It must NOT match a rule
    // whose whole purpose is to scope by tenant.
    expect(requiredPermission('/api/v1/admin/venues', 'POST')).toBeNull();
    expect(requiredPermission('/api/vx/t/sofia/admin/venues', 'POST')).toBeNull();
  });

  it('the more specific booking rules precede the generic one', () => {
    // Pins the ORDER, not just the outcome — a future edit that reorders
    // the array reintroduces the refund bug, and this catches it directly.
    const paths = ROUTE_PERMISSIONS.map((r) => r.pattern.source);
    const refund = paths.findIndex((p) => p.includes('refund'));
    const cancel = paths.findIndex((p) => p.includes('cancel'));
    const generic = paths.findIndex((p) => p.endsWith('bookings'));

    expect(refund).toBeLessThan(generic);
    expect(cancel).toBeLessThan(generic);
  });
});
