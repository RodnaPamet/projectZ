import { getToken } from 'next-auth/jwt';
import { type NextRequest, NextResponse } from 'next/server';

import { asSuperuser } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import type { PlayerzJWT } from '@/lib/auth/jwt-claims';
import { getPermissionsForRole } from '@/lib/permissions';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/t/{slug}/me — who am I, at this club?
 *
 * ═══ WHAT THIS ROUTE IS FOR ═══
 *
 * It is the first tenant-scoped, authenticated endpoint in the app, and it is
 * deliberately read-only. It proves the whole native chain end to end:
 *
 *   Authorization: Bearer <jwe>
 *     -> middleware getToken()            (signed in? does the token list it?)
 *     -> checkTenantAccess against /t/{slug}
 *     -> contextFromRequest               (session check + membership, from
 *                                          the database)
 *     -> a tenant-bound answer
 *
 * If any link is wrong, this returns the wrong thing in a way a test can see,
 * on a surface where being wrong cannot write anything.
 *
 * ═══ WHY IT READS THE DATABASE AND NOT THE TOKEN ═══
 *
 * The token's membership list is a MINT-TIME SNAPSHOT — and a native token has
 * no list at all. This route's entire job is to answer "what am I here", so it
 * never answered from the token: a client that just joined a club would have
 * been told it was not a member, by the one endpoint it would ask.
 *
 * Since #250 `contextFromRequest` resolves the membership from the database
 * for every tenant route, so this reads its answer from there and fetches only
 * what it adds: names, and when.
 *
 * ═══ tokenStale, AFTER #250 ═══
 *
 * It used to say "your claims disagree with the database, refresh" — and a
 * native token, which carries no claims, disagreed on every call, while its
 * refresh mints no claims either. A client that obeyed refreshed forever.
 *
 * What a claim can still do is make the EDGE too strict: a token that lists
 * this club with a role the database has since raised is refused, at the edge,
 * a mutation the new role allows. That is the one disagreement with a
 * consequence, so it is the one this reports. Absent claims have none — the
 * edge defers those to the database — so a native token is never stale.
 */
async function handler(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const requestContext = await contextFromRequest(req, { slug, requestId: getRequestId() });

  if (!requestContext.userId) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } },
      { status: 401 },
    );
  }

  const tenantId = requestContext.tenantId;

  // No ACTIVE membership here, no club by this slug, or a club behind a group
  // gate this session has not cleared: the context resolved all three to "no
  // tenant", from the same query, so they cannot be told apart below either.
  const found = tenantId
    ? // BYPASSRLS for one narrow question, as before #250: "what does THIS
      // user's membership of THIS club say?". Scoped to the caller's OWN
      // membership by userId and to the tenant the context just resolved, so it
      // can only ever return a row about the person asking, at a club the
      // context already admitted them to.
      await asSuperuser(requestContext, (db) =>
        db.tenantMembership.findFirst({
          where: { userId: requestContext.userId!, tenantId, status: 'ACTIVE' },
          select: {
            role: true,
            status: true,
            acceptedAt: true,
            createdAt: true,
            tenant: { select: { id: true, slug: true, name: true } },
            user: { select: { id: true, email: true, name: true, locale: true } },
          },
        }),
      )
    : null;

  // `!found.user` / `!found.tenant`: deleted between Prisma's selects, which
  // returns a required relation as null (#419). Gone reads as not found.
  if (!found?.user || !found.tenant) {
    // 404, not 403. "You are not a member" and "no such club" must be
    // indistinguishable, or this endpoint becomes a tenant-enumeration oracle.
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'Not found.' } },
      { status: 404 },
    );
  }

  return ok({
    user: {
      id: found.user.id,
      email: found.user.email,
      name: found.user.name,
      locale: found.user.locale,
    },
    tenant: found.tenant,
    membership: {
      role: found.role,
      status: found.status,
      // Derived from the role held HERE. Never from token.permissions, which
      // auth.ts freezes to memberships[0] — the cross-tenant escalation.
      permissions: [...getPermissionsForRole(found.role)],
      joinedAt: (found.acceptedAt ?? found.createdAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    },
    /**
     * True when the token LISTS this club with a tenant or role the database
     * disagrees with — the one case in which the edge, which still reads a
     * listed claim, may refuse something the database would allow.
     *
     * Not an error. For a web session the remedy is signing in again; a native
     * token lists no clubs and is never stale.
     */
    tokenStale: await listedClaimDisagrees(req, slug, found.tenant.id, found.role),
  });
}

/**
 * Does the token list this club, and say something about it the database does
 * not? Read off the token directly because `RequestContext` deliberately
 * carries none of its claims — this is a description of the token, not an
 * input to any decision.
 */
async function listedClaimDisagrees(
  req: NextRequest,
  slug: string,
  tenantId: string,
  role: string,
): Promise<boolean> {
  const decoded = (await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET,
  })) as unknown as PlayerzJWT | null;

  const listed = decoded?.memberships?.find((m) => m.tenantSlug === slug);
  return listed !== undefined && (listed.tenantId !== tenantId || listed.role !== role);
}

export const GET = defineV1Route(handler);
