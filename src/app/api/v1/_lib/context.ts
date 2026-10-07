import { getToken } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';

import type { RequestContext } from '@/app-layer/types';
import type { PlatformCapability } from '@/lib/platform/capabilities';
import type { PlayerzJWT } from '@/lib/auth/jwt-claims';
import { membershipContext } from '@/lib/auth/page-context';
import { checkSession } from '@/lib/auth/sessions';
import { AppError, ForbiddenError, UnauthorizedError } from '@/lib/errors/types';
import { requiredPermission } from '@/lib/security/route-permissions';

import { assertOwnOriginForCookieWrites, assertViewer } from './request-guard';

/**
 * Build the one object the app layer is allowed to trust.
 *
 * A use case never reads a cookie, a header or a session — `RequestContext` is
 * the sole carrier of "who is asking, about which club". This is where it is
 * assembled, and therefore the only place that can get it wrong.
 *
 * ═══ THE PER-TENANT BUG THIS EXISTS TO NOT REPEAT ═══
 *
 * `auth.ts` mints the JWT with `token.role` and `token.permissions` taken from
 * `memberships[0]` — whichever club the player joined FIRST. The edge
 * middleware then checks those permissions against the slug in the URL.
 *
 * An OWNER at club A who is merely a PLAYER at club B therefore carries
 * `admin.venue_manage` to club B: the membership check passes (they really are
 * a member of B) and the permission check passes (against A's role). That is
 * cross-tenant privilege escalation, and it is live the moment auth is mounted.
 *
 * So permissions are derived HERE from the membership that matches the slug
 * actually being addressed, and `token.role` / `token.permissions` are ignored
 * entirely. They are not read anywhere in this file, on purpose.
 *
 * ═══ THE MEMBERSHIP COMES FROM THE DATABASE, NOT THE TOKEN (#250) ═══
 *
 * This used to match the slug against `token.memberships`, and returned no
 * tenant when it was absent — "the route resolves membership authoritatively
 * against the database". Most routes did not, and it did not matter while the
 * edge refused every slug the token did not list. The edge no longer can:
 * native tokens list no clubs, web tokens list only those held at sign-in, and
 * #229 creates memberships after both. So the edge lets those requests through
 * undecided (`needs_db_check`), and THIS is where they are decided.
 *
 * It is the same query the pages use — `membershipContext`, one ACTIVE row by
 * (userId, slug) — so the API and the admin screens cannot disagree about who
 * belongs where. It also closes the other direction of staleness: a web token
 * keeps listing a club for up to seven days after the membership is suspended
 * or demoted, and its claims used to be believed here for all of them.
 *
 * Cost: one indexed query per tenant request, beside the session check that
 * already runs. It is the price of an answer that is right.
 *
 * ═══ AND IT ENFORCES THE PERMISSION TABLE, BECAUSE THE EDGE MAY NOT HAVE ═══
 *
 * On `needs_db_check` the middleware has no claim to derive permissions from,
 * so it skips its check and lets the mutation through to here. Nothing about
 * that may make the mutation ALLOWED. So before any tenant route's handler
 * runs, this looks up `requiredPermission` for the path and verb — the table
 * the edge uses — and refuses unless the database role at this club holds it.
 * One table, enforced twice: from the claim at the edge when there is one, from
 * the database here always.
 *
 * ═══ NO SILENT TENANT ═══
 *
 * `tenantId` is null unless a slug was supplied AND the caller holds an ACTIVE
 * membership for it. There is deliberately no fallback to "their first club":
 * a mobile client that forgets the slug should get an empty tenant and a clean
 * 403 downstream, never somebody else's data because we guessed.
 */

export interface ContextInput {
  /** The `:slug` from the route, if this route has one. */
  slug?: string | null;
  requestId: string;
  locale?: 'bg' | 'en';
  /**
   * Set ONLY by routes under `/api/v1/platform/**`, which is the only place
   * platform authority may be acted on.
   *
   * It exists to bound a cost. Almost nobody holds a grant, so resolving one on
   * every authenticated request would spend an indexed query per request to
   * answer "no". Everywhere else `appPermissions` stays `[]` — not a shortcut,
   * but the truth, and a guardrail keeps it true by asserting platform work
   * lives only under that prefix.
   */
  platformRoute?: boolean;
  /**
   * Set ONLY by `POST /t/{slug}/bookings`: the one tenant route a caller with
   * NO membership at the club may reach, because booking there is how a player
   * joins it (#229).
   *
   * It does not grant anything. The context still carries no tenant and no
   * permissions for a non-member; the route creates the PLAYER membership
   * itself, through `resolvePlayerTenant`, after it has validated the request,
   * and binds the tenant that call returns. A caller who IS a member is checked
   * against the table like everywhere else. `tenant-routes-resolve-membership`
   * pins this flag to that one file.
   */
  joinsAsPlayer?: boolean;
}

/**
 * Refused: no ACTIVE membership at this slug — which is also what "no such
 * club" looks like, deliberately. The same opaque body the edge used to send,
 * so a tenant route cannot be used to tell the two apart.
 */
function notAMember(): ForbiddenError {
  return new ForbiddenError('Forbidden');
}

/**
 * Refused: a member, whose role here lacks what the route needs. Same shape as
 * the edge's permission refusal, `details.requiredPermission` included — naming
 * a permission to somebody who belongs to the club discloses nothing about
 * which clubs exist.
 */
function lacksPermission(permission: string): AppError {
  return new AppError('Forbidden', 'FORBIDDEN', 403, true, { requiredPermission: permission });
}

export async function contextFromRequest(
  req: NextRequest,
  input: ContextInput,
): Promise<RequestContext> {
  // Before the token is even read: a cookie-authenticated write from another
  // origin is refused on the headers alone, so a forged request costs no
  // decrypt and no database read. See request-guard.ts.
  assertOwnOriginForCookieWrites(req);

  // Accepts a session cookie OR `Authorization: Bearer <jwe>` — next-auth's
  // getToken falls back to the header when no cookie is present, which is what
  // lets a native client reuse this pipeline unchanged.
  const raw = (await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET,
  })) as unknown as PlayerzJWT | null;

  // ═══ PLATFORM AUTHORITY IS NOT IN `base`, DELIBERATELY ═══
  //
  // `appPermissions` used to live here as `[] as readonly string[]`, spread
  // into all four returns below. That is how it stayed dead for two rounds: an
  // unread field with a plausible default reads as finished.
  //
  // It is now stated per-branch. A field in `base` is one every future return
  // path inherits WITHOUT deciding, and the whole reason this file exists is
  // that inheriting an authorisation value without deriving it is what caused
  // the cross-tenant escalation documented above.
  const base = {
    requestId: input.requestId,
    locale: input.locale ?? 'bg',
  };

  /**
   * No platform authority. The answer for every branch in this file today.
   *
   * Resolving a real grant needs a database read — it must NOT come from the
   * token, for exactly the reason `token.role` and `token.permissions` are
   * ignored here: a cached claim goes stale, and this is the highest privilege
   * in the system. That read lands with the `asPlatformAdmin` binding.
   */
  const noPlatformAuthority = {
    appPermissions: [] as readonly PlatformCapability[],
    platformGrantId: null as string | null,
  };

  /**
   * Platform authority, read from the database — never from the token.
   *
   * `token.role` and `token.permissions` are ignored throughout this file
   * because a stale claim became a cross-tenant escalation. This is the highest
   * privilege in the system and the one most likely to be revoked in a hurry,
   * so it gets the treatment that bug earned: revocation takes effect on the
   * next request, not when the token happens to expire.
   */
  const platformAuthority = async (userId: string | null) => {
    if (!input.platformRoute) return noPlatformAuthority;

    // ═══ DYNAMIC IMPORT, AND NOT FOR STYLE ═══
    //
    // A static import here pulls `@/lib/auth/platform-admin` →
    // `rls-middleware` → the Prisma singleton → `pg` into this module's graph.
    // `pg` touches `TextEncoder` at import time, which jsdom does not provide,
    // so every unit test that imports this file died with
    // "ReferenceError: TextEncoder is not defined" — measured, not predicted.
    //
    // Deferring it also matches the cost decision above: a request that is not
    // a platform route never loads the database layer through this path at all.
    //
    // Same shape as the `next-intl/server` problem this repo already hit: a
    // module that is fine in one runtime and fatal at import time in another.
    const { resolvePlatformAuthority } = await import('@/lib/auth/platform-admin');
    const { grantId, capabilities } = await resolvePlatformAuthority(userId);
    return { appPermissions: capabilities, platformGrantId: grantId };
  };

  const anonymous: RequestContext = {
    ...base,
    ...noPlatformAuthority,
    userId: null,
    tenantId: null,
    tenantSlug: null,
    role: null,
    permissions: [],
    userSessionId: null,
  };

  // What the permission table demands of this path and verb — the lookup the
  // edge makes, made again where the answer can be checked against the
  // database. Null for reads and for every path outside `/t/{slug}/`.
  const needed = requiredPermission(req.nextUrl.pathname, req.method);

  // Anonymous is a first-class case: public venue search, guest booking. It is
  // NOT one on a route that needs a permission, which is never public — the
  // edge refuses those with a 401 already, and this refuses them again rather
  // than hand a handler an anonymous context and trust it to check.
  if (!raw?.sub) {
    if (needed) throw new UnauthorizedError('Authentication required');
    return anonymous;
  }

  // ═══ A VALID SIGNATURE IS NOT THE SAME AS A WANTED SESSION ═══
  //
  // A JWT is valid because it verifies, not because anybody still wants it to
  // be. Without this check a token stays good until it expires: a password
  // change does not evict it, "sign out everywhere" does not reach it, and a
  // stolen token from a sold phone keeps working for its full lifetime.
  //
  // One indexed lookup, on a path that previously had none. That is the cost
  // of being able to take a token back, and it is the reason stateless JWTs
  // are attractive in the first place — worth paying here, and worth knowing
  // we are paying it.
  //
  // A dead session degrades to ANONYMOUS rather than throwing. The caller
  // already handles "not signed in" on every route; making it also handle
  // "signed in but revoked" would be a second path to get wrong, and the
  // observable behaviour is identical — you are not authenticated.
  const session = await checkSession({
    userSessionId: raw.userSessionId ?? null,
    sessionVersion: raw.sessionVersion ?? -1,
    sessionSecret: raw.sessionSecret ?? null,
  });

  if (!session.usable) {
    if (needed) throw new UnauthorizedError('Authentication required');
    return anonymous;
  }

  // The page that sent this was rendered for one account; the cookie may now be
  // another's (#263). Checked once the session is known to be live, and before
  // the membership read, so a stale tab costs no further query. A revoked or
  // absent session returned `anonymous` above — that is the route's 401, not a
  // viewer change. See request-guard.ts.
  assertViewer(req, raw.sub);

  // Usable, so this id is authentic: `checkSession` matched the token's
  // embedded secret against this row. The platform binding reads the
  // second-factor step-up from it (#262).
  const userSessionId = raw.userSessionId ?? null;

  const slug = input.slug ?? null;
  if (!slug) {
    // Every rule in the table is anchored at `/t/{slug}/`, so a route that
    // needs a permission and supplied no slug has lost the club it is about.
    // There is nothing to check the permission AGAINST, and guessing is how a
    // request gets another club's authority.
    if (needed) throw notAMember();

    // Signed in, but not addressing a club: /me/**, account settings, and
    // every platform route — which is why the grant read happens here.
    return {
      ...base,
      ...(await platformAuthority(raw.sub)),
      userId: raw.sub,
      tenantId: null,
      tenantSlug: null,
      role: null,
      permissions: [],
      userSessionId,
    };
  }

  // ═══ FROM THE DATABASE, EVERY TIME ═══
  //
  // Not from `raw.memberships`, whatever it says. A native token lists no
  // clubs, a web token lists the ones it was signed in with, and either can
  // list a club whose membership has since been suspended. See the header.
  const membership = await membershipContext(raw.sub, slug);

  if (membership.kind !== 'ok') {
    // No ACTIVE membership here, or no club called this: one answer for both.
    if (needed && !input.joinsAsPlayer) throw notAMember();

    // A read, or the join route. Signed in, no tenant — a handler that reaches
    // for one gets `MissingTenantError` from `inTenant`, never another club's.
    return {
      ...base,
      ...noPlatformAuthority,
      userId: raw.sub,
      tenantId: null,
      tenantSlug: null,
      role: null,
      permissions: [],
      userSessionId,
    };
  }

  const { ctx: held } = membership;

  // Derived from THIS membership's role, as the database holds it now. Never
  // from token.permissions, and no longer from the token's role for this club
  // either — that claim can be a week old.
  if (needed && !held.permissions.includes(needed)) throw lacksPermission(needed);

  return {
    ...base,
    ...noPlatformAuthority,
    userId: raw.sub,
    tenantId: held.tenantId,
    tenantSlug: held.tenantSlug,
    role: held.role,
    permissions: held.permissions,
    userSessionId,
  };
}
