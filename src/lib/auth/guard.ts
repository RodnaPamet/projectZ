/**
 * Tenant access control at the edge.
 *
 * The URL says which tenant you are asking about (`/t/sofia-padel/...`).
 * The JWT may say that you belong to it. It can NEVER say that you do not.
 *
 * ═══ WHY THE EDGE NO LONGER REFUSES A NON-MEMBER (#250) ═══
 *
 * This file used to answer 403 whenever the slug was missing from
 * `token.memberships`. That reading was only sound while the list was a
 * complete, current record of the caller's clubs, and it is neither:
 *
 *   - a NATIVE access token carries no `memberships` claim at all —
 *     `mintAccessToken` writes `{sub, userSessionId, sessionVersion}` — so every
 *     `/api/v1/t/{slug}/**` call from the iOS client was a 403 at the edge, on
 *     the caller's OWN club. Measured on main: `{"kind":"forbidden",
 *     "reason":"not_a_member"}` for a freshly minted token;
 *   - a WEB token's list is written once, at sign-in. #229 lets a signed-in
 *     player join any active club by booking there, so the membership that
 *     booking creates is absent from every token minted before it — and #229's
 *     own write, `POST /api/v1/t/{slug}/bookings`, was the first thing refused;
 *   - a list longer than MAX_JWT_MEMBERSHIPS is truncated by construction.
 *
 * The edge cannot read the database, so it cannot answer "is this user a
 * member of this slug" for a token that does not say. It now stops pretending
 * to: absence is `needs_db_check`, and the Node side resolves membership from
 * the database on every tenant request — `contextFromRequest` for the API,
 * `resolveTenantPageContext` / `requireTenantAction` for pages and Server
 * Actions. `tenant-routes-resolve-membership` pins that every tenant route goes
 * through the first.
 *
 * What a claim still buys is the fast path: a slug the token DOES list is let
 * through without a second thought, and a mutation there is refused here if the
 * claimed role lacks the permission. The route re-checks both against the
 * database, so a stale claim can make the edge too strict, never too lenient.
 *
 * This is defence in depth, not the defence. Postgres RLS is the guarantee
 * — even if this guard were bypassed entirely, a query bound to the wrong
 * tenant returns zero rows.
 */

import { getPermissionsForRole, isRole } from '@/lib/permissions';

export type AccessDecision =
  | { kind: 'allow' }
  | { kind: 'public' }
  | { kind: 'unauthenticated' }
  /**
   * Signed in, and the token does not list this tenant. That proves nothing —
   * see the header — so the request goes on and the route asks the database.
   *
   * NOT a softer "allow". Nothing about the caller's standing at this club was
   * established here, so the middleware must not treat it as a membership: it
   * skips the claim-based permission check, which has no claim to read, and the
   * route enforces the same permission table against the database instead.
   */
  | { kind: 'needs_db_check'; tenantSlug: string };

export interface TokenClaims {
  sub?: string;
  tenantSlug?: string | null;
  memberships?: Array<{ tenantSlug: string; role: string }>;
  /** Set when memberships[] was capped at MAX_JWT_MEMBERSHIPS. */
  membershipsTruncated?: boolean;
  /**
   * The user's UI language, carried on the token so middleware can seed the
   * locale cookie without a database read on every request.
   */
  locale?: string;
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
  // What crawlers read before anything else (#396). Reached today through the
  // `allow` default, like /login; named so tightening it cannot hide them.
  /^\/robots\.txt$/,
  /^\/sitemap\.xml$/,
  /^\/api\/venues(\/|$)/,
  // ═══ THE VERSIONED TWIN, WHICH WAS PUBLIC ONLY BY ACCIDENT ═══
  //
  // `/api/venues` was listed here and `/api/v1/venues` was not. The v1 reads
  // still reached anonymous callers, because `tenantSlugFromPath` finds no slug
  // in them and `checkTenantAccess` falls through to `allow` — the same
  // fail-open default this file tightens everywhere else, and warns about by
  // name three entries up for `/login`.
  //
  // Nothing failed while that was true, which is the problem: the day somebody
  // tightens that default, unauthenticated venue discovery breaks in the native
  // client, and no test disagrees. `openapi/playerz-v1.json` declares these four
  // operations `security: []`; a guardrail now holds the two in agreement.
  /^\/api\/v1\/venues(\/|$)/,
  // Centrifugo's subscribe callback. It carries no user token and never could:
  // the shared secret in `x-centrifugo-secret` is the whole boundary, which the
  // route's own docblock states. Also `security: []` in the spec.
  /^\/api\/v1\/realtime\/subscribe$/,
  // What a booking invite link is for (#358), shown before the sign-in wall:
  // the person holding the link usually has no session yet. One literal path.
  // Accepting it is NOT here: that needs a session, and the route says so.
  /^\/api\/v1\/booking-invites\/preview$/,
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
  // The NATIVE auth endpoints. Sign-in cannot require a session.
  //
  // Like /login, these are reachable today only because `checkTenantAccess`
  // finds no tenant slug in the path and falls through to `allow`. Naming them
  // means a future tightening of that default does not silently make it
  // impossible to obtain a token — which would be unrecoverable for a native
  // client, since there is no cookie path it could fall back to.
  //
  // Scoped to the three that must be anonymous. /api/v1/auth is NOT wildcarded:
  // this list's polarity is the opposite of the tenant matchers', so a loose
  // pattern here over-EXPOSES rather than over-enforces.
  /^\/api\/v1\/auth\/(token|refresh|logout)$/,
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
 *
 * `/invite/booking/{token}` is a booking invite (#358): a player added to a
 * game, not a member added to a club. Its page shows the game before asking
 * the visitor to sign in, so it must be reachable signed out too.
 */
const INVITE_PATTERNS: RegExp[] = [
  /^\/invite\/[^/]+$/,
  /^\/invite\/booking\/[^/]+$/,
  /^\/api\/invites\/[^/]+(\/|$)/,
];

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
 * ═══ ONLY FOR A SLUG THE TOKEN LISTS ═══
 *
 * With no matching claim this returns `[]`, which is the right answer to "what
 * does this TOKEN say you hold here" and the wrong answer to "what do you
 * hold here". So the middleware asks it only when `checkTenantAccess` said
 * `allow` — the token lists the slug. On `needs_db_check` there is nothing to
 * read, and the permission is enforced by the route instead, from the database:
 * `contextFromRequest` looks up the same `requiredPermission` and refuses before
 * the handler runs.
 *
 * This used to deny a mutation whenever the claim was missing, and said why:
 * letting it through would bypass authorisation, because "the routes do not
 * re-check". That was true, and it is what #250 changed — they re-check now,
 * against the database, on every request. The honest cost this recorded (a
 * player in more than MAX_JWT_MEMBERSHIPS clubs could not mutate at the
 * fifty-first) is gone with it. A mutation is never let through BECAUSE a claim
 * was absent; it is let through to the one layer that can answer.
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

/** Everything under here is platform-scoped and never tenant-scoped. */
const PLATFORM_PREFIX = '/api/v1/platform/';

export function checkTenantAccess(pathname: string, token: TokenClaims | null): AccessDecision {
  if (checkInviteCarveout(pathname)) return { kind: 'public' };
  if (checkPublicRoute(pathname)) return { kind: 'public' };

  // ═══ PLATFORM ROUTES NEED AUTHENTICATION, STATED RATHER THAN INHERITED ═══
  //
  // `/api/v1/platform/**` carries no tenant slug, so without this it falls into
  // the `!slug` allow below and reaches the route anonymously.
  //
  // ═══ WHAT THIS DOES AND DOES NOT BUY ═══
  //
  // It is worth being exact, because the obvious claims are both wrong.
  //
  // It does NOT change the status code. The routes already return 401 when
  // `ctx.userId` is null, so an anonymous caller got a 401 either way.
  //
  // It does NOT save a grant lookup. `contextFromRequest` returns the anonymous
  // context BEFORE it would resolve one — `resolvePlatformAuthority` is only
  // reached for a caller with a usable session — so an anonymous probe never
  // cost a query in the first place.
  //
  // What it buys is that the requirement is WRITTEN DOWN. Reaching the route at
  // all rested on `if (!slug) return allow`, the fail-open default this file
  // tightens everywhere else and warns about by name for `/login`. The day that
  // default is tightened or a route forgets its own `!ctx.userId` check, the
  // platform tree keeps failing closed because of this line rather than by
  // coincidence. It also refuses at the edge, so an unauthenticated request
  // never enters the Node handler.
  //
  // AUTHENTICATION ONLY. No capability check here: the edge never reads the
  // database, so it could only consult a token claim — and a token claim is
  // exactly what this design refuses for platform authority, because a cached
  // claim goes stale and revocation must take effect on the next request.
  if (pathname.startsWith(PLATFORM_PREFIX)) {
    return token?.sub ? { kind: 'allow' } : { kind: 'unauthenticated' };
  }

  const slug = tenantSlugFromPath(pathname);
  if (!slug) return { kind: 'allow' };

  if (!token?.sub) return { kind: 'unauthenticated' };

  // The fast path: the token lists this club. The route still re-reads the
  // membership, so a claim the database has since withdrawn buys nothing past
  // this line.
  if ((token.memberships ?? []).some((m) => m.tenantSlug === slug)) return { kind: 'allow' };

  // ═══ ABSENCE PROVES NOTHING, SO THE DATABASE DECIDES ═══
  //
  // A native token lists no clubs, a web token lists the clubs it was signed in
  // with, and a truncated one lists fifty. None of those is "not a member" —
  // see the header. Every tenant route resolves membership from the database
  // before it does anything else, and answers a non-member itself.
  //
  // "No such tenant" and "not a member of it" still cannot be told apart: both
  // arrive here with no claim, both get this answer, and the route reads both
  // as "no membership at this slug" from the same query. The difference would
  // be a tenant-enumeration oracle, at this layer or the next.
  return { kind: 'needs_db_check', tenantSlug: slug };
}
