import { type NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';

import { checkTenantAccess, type TokenClaims } from '@/lib/auth/guard';
import { requiredPermission } from '@/lib/security/route-permissions';

/**
 * Edge middleware.
 *
 * ORDER MATTERS, and it is the reverse of what feels natural:
 *
 *   1. health probes first — a liveness check that needs a valid session is
 *      not a liveness check, and a rate-limited one will get your pods
 *      killed during an incident, precisely when you least want that.
 *   2. read the token once.
 *   3. tenant access — is this your club at all?
 *   4. permission — are you allowed to do THIS to it?
 *
 * Steps 3 and 4 are defence in depth, not the defence. Postgres RLS is the
 * guarantee: even if this file were deleted, a query bound to the wrong
 * tenant returns zero rows. What the middleware buys is a clean 403 instead
 * of a baffling empty page, and a request that never reaches the database.
 */

/**
 * Probe paths — and they must name what is ACTUALLY on disk.
 *
 * This set used to name `/api/livez` and `/api/readyz`. Neither is a route
 * in this app, and neither is what anything probes: the container's
 * HEALTHCHECK hits `/api/health` (Dockerfile) and Gatus hits `/api/health`
 * and `/api/ready` (ops/gatus.yaml). So readiness did not bypass at all.
 *
 * It still answered 200, which is why nobody noticed — but only by falling
 * through `checkTenantAccess`'s "no tenant in this path" branch, i.e. via
 * the same fail-open default that steps 3 and 4 exist to compensate for,
 * rather than by any rule that names it. Tighten that default and the
 * readiness probe starts 401ing; the orchestrator then pulls every pod out
 * of rotation, and the cause is three files away from the edit.
 *
 * It also paid a JWE decrypt on every probe, on the edge, several times a
 * second per pod — including during the incident when the orchestrator is
 * deciding whether this pod still deserves traffic.
 *
 * `/api/metrics` is deliberately NOT here. It is not a probe: it is
 * bearer-authenticated on purpose, and a middleware bypass is a step
 * toward publishing our booking volume.
 *
 * `health-checks` pins this set against the routes that exist.
 */
const HEALTH_PATHS = new Set(['/api/health', '/api/ready']);

/**
 * The canonical error envelope, hand-written.
 *
 * `withApiErrorHandling` owns this shape for route handlers
 * (`ApiErrorResponse` in `@/lib/errors/types`), but this file runs on the
 * Edge runtime and that module pulls in Node-only code. So the shape is
 * duplicated here deliberately, and `api-error-envelope` pins the copy to
 * the original.
 *
 * The shape matters more than it looks. This file used to answer
 * `{"error":"forbidden"}` while every wrapped route answers
 * `{"error":{"code":…,"message":…}}` — a String where a struct belongs. A
 * browser shrugs at that. A native client decodes ONE error type, so the
 * mismatch turns a clean 403 into an unrecognisable decode failure, in a
 * binary that cannot be hotfixed for a week.
 */
function apiError(status: number, code: string, message: string, details?: unknown) {
  return NextResponse.json(
    { error: details === undefined ? { code, message } : { code, message, details } },
    { status },
  );
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // 1. Probes bypass everything.
  if (HEALTH_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  // 2. One token read for the whole pipeline.
  const raw = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  const token = raw as unknown as TokenClaims | null;

  // 3. Tenant access.
  const access = checkTenantAccess(pathname, token);

  switch (access.kind) {
    case 'public':
    case 'allow':
      break;

    case 'unauthenticated': {
      if (pathname.startsWith('/api/')) {
        return apiError(401, 'UNAUTHORIZED', 'Authentication required');
      }
      const login = new URL('/login', req.url);
      login.searchParams.set('next', pathname);
      return NextResponse.redirect(login);
    }

    case 'needs_db_check':
      // The token's membership list was truncated, so we cannot rule the
      // user out here. Let it through — the route resolves membership
      // authoritatively, and RLS is the backstop either way. Denying at the
      // edge would lock a player out of their 51st club.
      break;

    case 'forbidden':
      // Deliberately the same opaque message the permission branch uses:
      // "no such tenant" and "not a member of it" must be indistinguishable,
      // or this becomes a tenant-enumeration oracle.
      return pathname.startsWith('/api/')
        ? apiError(403, 'FORBIDDEN', 'Forbidden')
        : new NextResponse('Forbidden', { status: 403 });
  }

  // 4. Permission on mutations.
  const needed = requiredPermission(pathname, req.method);
  if (needed) {
    const perms = (raw as { permissions?: string[] } | null)?.permissions ?? [];
    if (!perms.includes(needed)) {
      return apiError(403, 'FORBIDDEN', 'Forbidden', { requiredPermission: needed });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Everything except Next internals and static assets. A matcher that
    // accidentally excludes /api/** is the classic way to ship a guard that
    // protects the pages and leaves the data open.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|css|js)$).*)',
  ],
};
