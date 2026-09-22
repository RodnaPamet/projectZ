/**
 * Tenant access control at the edge.
 *
 * The URL says which tenant you are asking about (`/t/sofia-padel/...`).
 * The JWT says which tenants you actually belong to. If those disagree, the
 * request stops here.
 *
 * This is defence in depth, not the defence. Postgres RLS is the guarantee
 * — even if this guard were bypassed entirely, a query bound to the wrong
 * tenant returns zero rows. What this buys is a clean 403 instead of a
 * confusing empty page, and a request that never touches the database.
 */

export type AccessDecision =
  | { kind: 'allow' }
  | { kind: 'public' }
  | { kind: 'unauthenticated' }
  /**
   * The token's membership list was TRUNCATED, and the requested tenant is
   * not in the part we can see. We cannot conclude "not a member" from an
   * incomplete list — so the caller must ask the database.
   *
   * Denying here instead would lock a player out of their 51st club: a bug
   * that only appears for the most engaged users, and looks like a
   * permissions problem rather than a truncation one.
   */
  | { kind: 'needs_db_check'; tenantSlug: string }
  | { kind: 'forbidden'; reason: string };

export interface TokenClaims {
  sub?: string;
  tenantSlug?: string | null;
  memberships?: Array<{ tenantSlug: string; role: string }>;
  /** Set when memberships[] was capped at MAX_JWT_MEMBERSHIPS. */
  membershipsTruncated?: boolean;
}

/** Routes anyone may see, signed in or not. */
const PUBLIC_PATTERNS: RegExp[] = [
  /^\/$/,
  /^\/venues(\/|$)/,
  /^\/open-play(\/|$)/,
  /^\/coaches(\/|$)/,
  /^\/design-system(\/|$)/,
  /^\/api\/venues(\/|$)/,
  // The orchestrator's probes. These are the paths that EXIST — `/api/livez`
  // and `/api/readyz` were listed here for a while and are not routes, which
  // meant readiness was public only by accident, via the `allow` default.
  //
  // One literal line per route, never a wildcard: this list's polarity is the
  // opposite of the tenant matchers', so a loose pattern here does not
  // over-enforce, it over-EXPOSES. `/api/metrics` is bearer-authenticated and
  // must never appear.
  /^\/api\/health$/,
  /^\/api\/ready$/,
  /^\/api\/auth(\/|$)/,
];

/**
 * Invite acceptance is a deliberate carve-out.
 *
 * You are invited to a tenant you are not yet a member of — so by
 * definition your JWT has no membership for it, and `checkTenantAccess`
 * would (correctly) deny you. Without this, an invite link is unusable by
 * exactly the person it was sent to.
 *
 * The token in the URL is the credential here; the redeem route verifies it
 * against the hashed value and its expiry.
 */
const INVITE_PATTERNS: RegExp[] = [/^\/invite\/[^/]+$/, /^\/api\/invites\/[^/]+(\/|$)/];

export function checkPublicRoute(pathname: string): boolean {
  return PUBLIC_PATTERNS.some((re) => re.test(pathname));
}

export function checkInviteCarveout(pathname: string): boolean {
  return INVITE_PATTERNS.some((re) => re.test(pathname));
}

/**
 * Pull the tenant slug out of `/t/:slug/...`, `/api/t/:slug/...`, or the
 * versioned API form `/api/v1/t/:slug/...`.
 *
 * The optional version segment is load-bearing, not tidiness. This matcher
 * fails toward "no tenant in this path", and `checkTenantAccess` reads that
 * as `{ kind: 'allow' }` — so a tenant URL shape this regex does NOT
 * recognise is not merely unmatched, it is UNGUARDED, and `requiredPermission`
 * goes quiet at the same moment for the same reason.
 *
 * Any new URL shape carrying a tenant must be added here in the commit that
 * introduces it, and to the patterns in `@/lib/security/route-permissions`.
 */
export function tenantSlugFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/(?:api\/(?:v\d+\/)?)?t\/([^/]+)/);
  return m?.[1] ?? null;
}

export function checkTenantAccess(pathname: string, token: TokenClaims | null): AccessDecision {
  if (checkInviteCarveout(pathname)) return { kind: 'public' };
  if (checkPublicRoute(pathname)) return { kind: 'public' };

  const slug = tenantSlugFromPath(pathname);
  if (!slug) return { kind: 'allow' };

  if (!token?.sub) return { kind: 'unauthenticated' };

  const memberships = token.memberships ?? [];
  const member = memberships.some((m) => m.tenantSlug === slug);

  if (member) return { kind: 'allow' };

  // Absence from a TRUNCATED list proves nothing. Ask the database rather
  // than locking a player out of their 51st club.
  if (token.membershipsTruncated) {
    return { kind: 'needs_db_check', tenantSlug: slug };
  }

  // Do NOT distinguish "no such tenant" from "not a member of it" — that
  // difference is a tenant-enumeration oracle.
  return { kind: 'forbidden', reason: 'not_a_member' };
}
