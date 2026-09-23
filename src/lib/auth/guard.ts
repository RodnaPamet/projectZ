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

import { getPermissionsForRole, isRole } from '@/lib/permissions';

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
  // Sign-in must be public, and EXPLICITLY so.
  //
  // It reaches users today only because `checkTenantAccess` finds no tenant
  // slug in `/login` and falls through to its `allow` default — the same
  // fail-open behaviour being tightened everywhere else. That matters more
  // here than elsewhere: middleware REDIRECTS unauthenticated users to
  // /login, so the day that default is tightened, /login denies, which
  // redirects to /login, which denies. A redirect loop on the one page that
  // could fix it.
  /^\/login$/,
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

/**
 * The permissions this token actually holds AT THIS PATH.
 *
 * ═══ THE ESCALATION THIS REPLACES ═══
 *
 * `auth.ts` mints `token.permissions` from `memberships[0]` — whichever club
 * the player joined FIRST (the list is ordered by createdAt). The middleware
 * then checked that frozen array against the permission required by the URL.
 *
 * `checkTenantAccess` above correctly verifies you are a MEMBER of the slug in
 * the path. The permission check used a different club's ROLE. So an OWNER at
 * club A who is merely a PLAYER at club B passed both:
 *
 *   membership check   member of B?            yes
 *   permission check   has admin.venue_manage? yes — because A made them OWNER
 *
 * That is cross-tenant privilege escalation on every mutating tenant route,
 * and it is live the moment authentication is mounted.
 *
 * Deriving from the membership that matches the PATH is the same thing
 * `contextFromRequest` does for v1 routes. This is the edge half of that fix.
 * `token.permissions` and `token.role` are not read here, deliberately.
 *
 * ═══ THE TRUNCATED CASE, AND WHY IT DENIES ═══
 *
 * `buildMembershipClaims` caps the list at MAX_JWT_MEMBERSHIPS for a header
 * budget. A player in more clubs than that carries an incomplete list, so a
 * missing membership does not prove non-membership — which is why
 * `checkTenantAccess` returns `needs_db_check` and lets the request through.
 *
 * This cannot do the same. Letting a mutation through with NO permission check
 * would mean the one class of user whose claims we admit are incomplete is
 * also the one class that bypasses authorisation entirely — and the routes do
 * not re-check: the admin stub says outright that it has no permission check
 * "on purpose — the middleware has already enforced admin.venue_manage".
 *
 * So it denies, and the honest cost is recorded: a player in more than
 * MAX_JWT_MEMBERSHIPS clubs cannot perform a mutation at a club outside the
 * first fifty until the edge can resolve membership authoritatively. Denying a
 * rare legitimate user beats admitting every attacker who can join fifty-one
 * clubs.
 */
export function permissionsForPath(pathname: string, token: TokenClaims | null): string[] {
  const slug = tenantSlugFromPath(pathname);
  if (!slug || !token) return [];

  const membership = (token.memberships ?? []).find((m) => m.tenantSlug === slug);

  // `role` is a string off a token, not a value Prisma produced, so it is
  // checked rather than cast. An unrecognised role grants nothing.
  if (!membership || !isRole(membership.role)) return [];

  return [...getPermissionsForRole(membership.role)];
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
