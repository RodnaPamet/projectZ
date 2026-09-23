import type { Permission } from '@/lib/permissions';

/**
 * Route → required permission.
 *
 * The table is the security boundary. Hiding a nav link (see `AppNav`) is a
 * UI courtesy — the URL is still typeable, and `curl` does not read your
 * navigation. This is what actually denies.
 *
 * DEFAULT DENY on mutations: `requiredPermission()` returns a permission for
 * any write under `/api/t/:slug/`, and the guardrail
 * (`route-permission-coverage`) fails the build if a mutating route exists
 * with no rule. A new admin endpoint cannot ship unprotected by omission —
 * which is exactly how these holes are usually created.
 *
 * Every pattern accepts an OPTIONAL version segment (`/api/v1/t/:slug/...`)
 * because this table denies by MATCHING. A rule anchored at `^/api/t/` does
 * not merely miss a versioned route — it returns `null`, which
 * `middleware.ts` reads as "no permission required". Shipping `/api/v1`
 * against an unversioned table would silently open every mutation in it to
 * any authenticated member. `route-permissions.test.ts` asserts the version
 * group on every rule so a new one cannot be added without it.
 */

export interface RoutePermission {
  pattern: RegExp;
  methods: readonly string[];
  permission: Permission;
}

export const ROUTE_PERMISSIONS: readonly RoutePermission[] = [
  // ── Venue administration ──────────────────────────────────────────
  {
    pattern: /^\/api\/(?:v\d+\/)?t\/[^/]+\/admin\/venues/,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    permission: 'admin.venue_manage',
  },
  {
    pattern: /^\/api\/(?:v\d+\/)?t\/[^/]+\/admin\/staff/,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    permission: 'admin.staff_manage',
  },
  {
    pattern: /^\/api\/(?:v\d+\/)?t\/[^/]+\/admin\/pricing/,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    permission: 'admin.pricing_manage',
  },
  {
    pattern: /^\/api\/(?:v\d+\/)?t\/[^/]+\/admin\/courts/,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    permission: 'courts.manage',
  },

  // ── SSO / identity federation ─────────────────────────────────────
  //
  // Every mutating verb, including DELETE: removing a mapping silently stops
  // a whole group being promoted at their next sign-in, which is as
  // consequential as adding one and far less likely to be noticed.
  {
    pattern: /^\/api\/(?:v\d+\/)?t\/[^/]+\/sso\/entra\/group-mappings/,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    permission: 'sso.manage',
  },

  // ── Bookings ──────────────────────────────────────────────────────
  //
  // ORDER MATTERS. `/bookings/:id/refund` also matches `/bookings`, so the
  // more specific rules MUST come first — `requiredPermission` returns the
  // first match. Reversed, a refund would only require `bookings.create`,
  // and any PLAYER could refund themselves.
  {
    pattern: /^\/api\/(?:v\d+\/)?t\/[^/]+\/bookings\/[^/]+\/refund/,
    methods: ['POST'],
    permission: 'payments.refund',
  },
  {
    pattern: /^\/api\/(?:v\d+\/)?t\/[^/]+\/bookings\/[^/]+\/cancel/,
    methods: ['POST'],
    permission: 'bookings.cancel',
  },
  {
    pattern: /^\/api\/(?:v\d+\/)?t\/[^/]+\/bookings/,
    methods: ['POST'],
    permission: 'bookings.create',
  },

  // ── Players / credit ──────────────────────────────────────────────
  {
    pattern: /^\/api\/(?:v\d+\/)?t\/[^/]+\/players\/[^/]+\/credit/,
    methods: ['POST', 'PUT', 'PATCH'],
    permission: 'players.credit_adjust',
  },

  // ── Open play ─────────────────────────────────────────────────────
  {
    pattern: /^\/api\/(?:v\d+\/)?t\/[^/]+\/sessions\/[^/]+\/moderate/,
    methods: ['POST', 'DELETE'],
    permission: 'openplay.moderate',
  },
  {
    pattern: /^\/api\/(?:v\d+\/)?t\/[^/]+\/sessions/,
    methods: ['POST'],
    permission: 'openplay.host',
  },
] as const;

export function requiredPermission(pathname: string, method: string): Permission | null {
  const m = method.toUpperCase();
  for (const rule of ROUTE_PERMISSIONS) {
    if (rule.methods.includes(m) && rule.pattern.test(pathname)) {
      return rule.permission;
    }
  }
  return null;
}
