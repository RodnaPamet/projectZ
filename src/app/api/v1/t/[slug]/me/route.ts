import { type NextRequest, NextResponse } from 'next/server';

import { asSuperuser } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
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
 *     -> middleware getToken()            (the app's only session read)
 *     -> checkTenantAccess against /t/{slug}
 *     -> contextFromRequest               (session check + per-tenant role)
 *     -> a tenant-bound answer
 *
 * If any link is wrong, this returns the wrong thing in a way a test can see,
 * on a surface where being wrong cannot write anything.
 *
 * ═══ WHY IT READS THE DATABASE AND NOT THE TOKEN ═══
 *
 * `contextFromRequest` derives role and permissions from the membership in the
 * TOKEN that matches this slug — correctly, and that is what authorises
 * mutations elsewhere. But the token's membership list is a MINT-TIME
 * SNAPSHOT.
 *
 * A native access token lives 15 minutes and its refresh token 30 days, and
 * nothing re-mints the claims in between. So a player who joins a club, or is
 * promoted, or is removed, carries stale claims until they sign in again. For
 * most routes that is tolerable — the worst case is a 403 they can fix by
 * retrying.
 *
 * For THIS route it is not, because this route's entire job is to answer
 * "what am I here". Answering it from the token would mean a client that just
 * joined a club is told it is not a member, by the one endpoint it would ask.
 *
 * So the membership is read authoritatively, and `tokenStale` tells the client
 * when its claims disagree — which is the signal to refresh rather than to
 * show an error.
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

  // BYPASSRLS for one narrow question: "does THIS user belong to THIS club?".
  //
  // It cannot be answered with `inTenant`, because binding a tenant requires
  // already knowing its id — which is the thing a stale token may be missing.
  // The read is scoped to the caller's OWN membership by userId, so it crosses
  // no tenant boundary it should not: it can only ever return a row about the
  // person asking.
  const found = await asSuperuser(requestContext, (db) =>
    db.tenantMembership.findFirst({
      where: {
        userId: requestContext.userId!,
        status: 'ACTIVE',
        tenant: { slug },
      },
      select: {
        role: true,
        status: true,
        acceptedAt: true,
        createdAt: true,
        tenant: { select: { id: true, slug: true, name: true } },
        user: { select: { id: true, email: true, name: true, locale: true } },
      },
    }),
  );

  if (!found) {
    // 404, not 403. "You are not a member" and "no such club" must be
    // indistinguishable, or this endpoint becomes a tenant-enumeration oracle —
    // the same reasoning `checkTenantAccess` uses when it refuses to
    // distinguish them.
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
     * True when the token's claims disagree with the database.
     *
     * Not an error. It is the signal for a native client to refresh its token
     * so that the EDGE — which authorises mutations from claims alone, and
     * never consults the database — stops working from a stale role.
     */
    tokenStale: requestContext.tenantId !== found.tenant.id || requestContext.role !== found.role,
  });
}

export const GET = defineV1Route(handler);
