import type { Role } from '@prisma/client';
import { getToken } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';

import type { RequestContext } from '@/app-layer/types';
import type { PlatformCapability } from '@/lib/platform/capabilities';
import type { PlayerzJWT } from '@/lib/auth/jwt-claims';
import { checkSession } from '@/lib/auth/sessions';
import { getPermissionsForRole } from '@/lib/permissions';

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
 * So permissions are re-derived HERE from the membership that matches the slug
 * actually being addressed, and `token.role` / `token.permissions` are ignored
 * entirely. They are not read anywhere in this file, on purpose.
 *
 * ═══ NO SILENT TENANT ═══
 *
 * `tenantId` is null unless a slug was supplied AND the caller holds a
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
}

export async function contextFromRequest(
  req: NextRequest,
  input: ContextInput,
): Promise<RequestContext> {
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
  };

  // Anonymous is a first-class case: public venue search, guest booking.
  if (!raw?.sub) return anonymous;

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

  if (!session.usable) return anonymous;

  const slug = input.slug ?? null;
  if (!slug) {
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
    };
  }

  const membership = (raw.memberships ?? []).find((m) => m.tenantSlug === slug);

  if (!membership) {
    // Absent from a TRUNCATED list proves nothing — the caller may hold a
    // membership we could not fit in the token. Return no tenant rather than a
    // wrong one; the route resolves membership authoritatively against the
    // database, and RLS is the backstop either way.
    //
    // Denying here instead would lock a player out of their 51st club.
    return {
      ...base,
      ...noPlatformAuthority,
      userId: raw.sub,
      tenantId: null,
      tenantSlug: null,
      role: null,
      permissions: [],
    };
  }

  const role = membership.role as Role;

  return {
    ...base,
    ...noPlatformAuthority,
    userId: raw.sub,
    tenantId: membership.tenantId,
    tenantSlug: membership.tenantSlug,
    role,
    // Derived from THIS membership's role. Never from token.permissions.
    permissions: getPermissionsForRole(role),
  };
}
