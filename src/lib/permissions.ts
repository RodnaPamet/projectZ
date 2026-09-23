import type { Role } from '@prisma/client';

/**
 * The playerz permission model.
 *
 * inflect's `PermissionSet` is `controls / evidence / policies / risks /
 * vendors / tests` — a compliance product. This is a booking product, so
 * the shape is ported and the content is not.
 *
 * Permissions are dotted strings rather than a nested boolean tree because
 * they cross a wire (JWT claims, API-key scopes) and a flat string list
 * survives that trip without a bespoke serializer.
 */

export const PERMISSIONS = [
  // ── Venue administration ──────────────────────────────────────────
  'admin.venue_manage',
  'admin.staff_manage',
  'admin.pricing_manage',
  'admin.billing_manage',
  'admin.owner_management',
  /// Suspending or closing the tenant itself. OWNER only, always.
  'admin.tenant_lifecycle',
  /// Configuring which Entra security group grants which role.
  ///
  /// OWNER only, and deliberately not given to MANAGER. Creating a mapping is
  /// not "an SSO setting" — it is the power to promote everyone in a directory
  /// group to that role, exercised by editing a group this application does not
  /// control. A MANAGER holding this could map a group they administer to
  /// MANAGER and mint peers at will.
  'sso.manage',

  // ── Bookings ──────────────────────────────────────────────────────
  'bookings.create',
  'bookings.cancel',
  'bookings.refund',
  /// See every booking at the venue, not just your own.
  'bookings.view_all',

  // ── Courts ────────────────────────────────────────────────────────
  'courts.manage',
  'availability.manage',

  // ── Coaching ──────────────────────────────────────────────────────
  'coaches.list',
  'coaches.manage_own_calendar',
  'coaches.book',

  // ── Open play ─────────────────────────────────────────────────────
  'openplay.host',
  'openplay.join',
  'openplay.moderate',

  // ── Players ───────────────────────────────────────────────────────
  'players.view',
  'players.credit_adjust',

  // ── Money ─────────────────────────────────────────────────────────
  'payments.refund',
  'payments.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Role → permissions.
 *
 * Typed as `readonly Permission[]`, so a typo (`'bookings.cancle'`) is a
 * compile error rather than a permission that silently never matches — the
 * failure mode of a stringly-typed ACL is a check that always returns
 * false, which looks like "correctly denied" in every test you'd think to
 * write.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: [...PERMISSIONS],

  MANAGER: [
    'admin.venue_manage',
    'admin.staff_manage',
    'admin.pricing_manage',
    'admin.billing_manage',
    'bookings.create',
    'bookings.cancel',
    'bookings.refund',
    'bookings.view_all',
    'courts.manage',
    'availability.manage',
    'coaches.list',
    'coaches.book',
    'openplay.host',
    'openplay.join',
    'openplay.moderate',
    'players.view',
    'players.credit_adjust',
    'payments.refund',
    'payments.view',
    // NOT admin.owner_management, NOT admin.tenant_lifecycle — a manager
    // must not be able to promote themselves to owner or close the club.
  ],

  STAFF: [
    'bookings.create',
    'bookings.cancel',
    'bookings.view_all',
    'availability.manage',
    'coaches.list',
    'coaches.book',
    'openplay.join',
    'players.view',
    'payments.view',
    // Front-desk staff can take and cancel bookings, but NOT issue refunds
    // (payments.refund) — money movement needs a manager.
  ],

  COACH: [
    'bookings.create',
    'coaches.list',
    'coaches.manage_own_calendar',
    'openplay.host',
    'openplay.join',
    'players.view',
  ],

  PLAYER: ['bookings.create', 'bookings.cancel', 'coaches.list', 'coaches.book', 'openplay.join'],
};

/**
 * Is this string one of the roles the schema defines?
 *
 * Every caller inside the app already holds a `Role` that Prisma produced.
 * The edge does not — it holds a string off a JWT, and that token may have
 * been minted by a deploy that predates a role being renamed or removed.
 * Indexing the table with such a string yields `undefined`, which the caller
 * then spreads or calls `.includes` on: a 500 at the edge, on every request,
 * from a claim we had already decided we do not recognise.
 *
 * Keyed off ROLE_PERMISSIONS itself, so it cannot drift from the table it
 * guards.
 */
export function isRole(value: string): value is Role {
  return Object.hasOwn(ROLE_PERMISSIONS, value);
}

export function getPermissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
