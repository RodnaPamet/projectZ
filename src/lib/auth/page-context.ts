import { cache } from 'react';

import { cookies, headers } from 'next/headers';
import { getToken } from 'next-auth/jwt';

import type { PlayerzJWT } from '@/lib/auth/jwt-claims';
import { checkSession } from '@/lib/auth/sessions';
import { getPermissionsForRole, type Permission } from '@/lib/permissions';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import type { Role } from '@prisma/client';

/**
 * Who is asking, about which club — for a SERVER COMPONENT.
 *
 * ═══ WHY THIS EXISTS SEPARATELY FROM contextFromRequest ═══
 *
 * `src/app/api/v1/_lib/context.ts` is the one place a route assembles the
 * object the app layer is allowed to trust. It takes a `NextRequest`, which a
 * page does not have and cannot obtain — so before this file, NO page in the
 * repo resolved a tenant at all. The only data-bound page, `/venues`, is public
 * and deliberately tenant-less.
 *
 * This is the page-side equivalent. It makes the same three promises, for the
 * same reasons, and the reasons are worth restating because getting any of them
 * wrong is a cross-tenant escalation rather than a bug.
 *
 * ═══ 1. THE ROLE IS NEVER READ FROM THE TOKEN ═══
 *
 * `auth.ts` mints `token.role` from `memberships[0]` — whichever club the user
 * joined FIRST. An OWNER at club A who is a PLAYER at club B therefore carries
 * owner permissions in a token presented to club B. `context.ts` documents this
 * at length and refuses to read those claims; so does this.
 *
 * ═══ 2. MEMBERSHIP IS RESOLVED FROM THE DATABASE, NOT THE CLAIM LIST ═══
 *
 * `context.ts` matches the slug against `token.memberships` and notes that
 * absence from a TRUNCATED list proves nothing — it returns no tenant and lets
 * the route resolve authoritatively, with RLS as the backstop.
 *
 * A page has no such downstream, so it asks the database directly. That costs
 * one indexed query and it is the difference between a correct answer and one
 * that locks a player out of their 51st club.
 *
 * ═══ 3. A VALID SIGNATURE IS NOT A WANTED SESSION ═══
 *
 * `checkSession` is what makes "sign out everywhere" and a password change
 * reach a token that has not expired. Skipping it here would mean a revoked
 * session still renders an admin screen until its JWT aged out.
 *
 * ═══ WHY THE MEMBERSHIP READ IS runAsSuperuser ═══
 *
 * It is the chicken-and-egg case. `tenant_membership` carries FORCE row
 * security keyed on `app.tenant_id`, and the whole point of this call is to
 * discover WHICH tenant to bind to — there is nothing to set yet. Bound as
 * `app_user` with no tenant the query returns zero rows and every caller would
 * read that as "not a member".
 *
 * The read is narrow by construction: one row, by `(userId, tenantSlug)`, both
 * supplied by the caller's own session. It cannot enumerate. `src/auth.ts` and
 * `/t/[slug]/me` reach for the same binding for the same reason, and are
 * already pinned in `superuser-call-sites`.
 */

/** What a page needs to know before it may render anything club-specific. */
export interface TenantPageContext {
  userId: string;
  tenantId: string;
  tenantSlug: string;
  role: Role;
  permissions: readonly Permission[];
}

export type TenantPageResult =
  | { kind: 'ok'; ctx: TenantPageContext }
  /** No usable session. The caller redirects to sign-in. */
  | { kind: 'unauthenticated' }
  /**
   * No such club, or the caller is not a member of it.
   *
   * ONE value for both, deliberately. Distinguishing them turns any admin URL
   * into a tenant-enumeration oracle, which is the same reason
   * `checkTenantAccess` refuses to separate them.
   */
  | { kind: 'not-a-member' };

/** Read the session JWT from the incoming request, inside a server component. */
async function tokenFromHeaders(): Promise<PlayerzJWT | null> {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);

  // `getToken` wants something request-shaped. It reads the session cookie by
  // name and falls back to the `authorization` header, so those two are all it
  // needs — and passing the real cookie jar keeps the chunked-cookie handling
  // (`__Secure-next-auth.session-token.0`, `.1`, …) that a hand-parsed
  // `cookie:` header would silently lose on a large token.
  const req = {
    cookies: cookieStore,
    headers: headerList,
  } as unknown as Parameters<typeof getToken>[0]['req'];

  return (await getToken({ req, secret: process.env.NEXTAUTH_SECRET })) as PlayerzJWT | null;
}

/**
 * Resolve the caller's standing at `slug`, or say why they have none.
 *
 * Returns a discriminated union rather than throwing or redirecting: a layout
 * wants to redirect, a page may want to render a 404, and a component deciding
 * that for them is how `notFound()` ends up called from somewhere that needed a
 * sign-in prompt.
 */
export const resolveTenantPageContext = cache(_resolveTenantPageContext);

/**
 * Wrapped in React `cache` above, which is not an optimisation so much as a
 * correctness convenience: a layout and the page beneath it BOTH need the
 * context, App Router gives a layout no way to pass props down, and without
 * deduping every admin screen would run the session check and the membership
 * query twice per render. `cache` is per-request, so two callers in one render
 * share one result and a second request still re-reads — which matters,
 * because revocation has to bite on the next request.
 */
async function _resolveTenantPageContext(slug: string): Promise<TenantPageResult> {
  const token = await tokenFromHeaders();
  if (!token?.sub) return { kind: 'unauthenticated' };

  const session = await checkSession({
    userSessionId: token.userSessionId ?? null,
    sessionVersion: token.sessionVersion ?? -1,
    sessionSecret: token.sessionSecret ?? null,
  });
  if (!session.usable) return { kind: 'unauthenticated' };

  return membershipContext(token.sub, slug);
}

/**
 * The database half, exported so it can be tested without a request scope.
 *
 * `next/headers` throws outside one, so a test of the whole function would have
 * to mock the session reader and would then be testing the mock. This is the
 * part with the interesting failure modes — the ACTIVE filter, the slug join,
 * and permissions coming from the matched membership rather than the token.
 */
export async function membershipContext(userId: string, slug: string): Promise<TenantPageResult> {
  const membership = await runAsSuperuser((db) =>
    db.tenantMembership.findFirst({
      // `status: ACTIVE` is load-bearing. INVITED means they were asked and
      // have not accepted; SUSPENDED and EXPIRED mean they were a member and
      // are not now. Any of the three rendering an admin screen would be a
      // membership check that only asks whether a row exists.
      where: { userId, status: 'ACTIVE', tenant: { slug } },
      select: { tenantId: true, role: true, tenant: { select: { slug: true } } },
    }),
  );

  if (!membership) return { kind: 'not-a-member' };

  return {
    kind: 'ok',
    ctx: {
      userId,
      tenantId: membership.tenantId,
      tenantSlug: membership.tenant.slug,
      role: membership.role,
      // Derived from the membership that matches THIS slug. Never the token.
      permissions: getPermissionsForRole(membership.role),
    },
  };
}
