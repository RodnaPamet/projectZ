import { type NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';

import { checkTenantAccess, permissionsForPath, type TokenClaims } from '@/lib/auth/guard';
import { requiredPermission } from '@/lib/security/route-permissions';
import { LOCALE_COOKIE, isLocale } from '@/lib/i18n/locales';

/**
 * Edge middleware.
 *
 * ORDER MATTERS, and it is the reverse of what feels natural:
 *
 *   1. health probes first — a liveness check that needs a valid session is
 *      not a liveness check, and a rate-limited one will get your pods
 *      killed during an incident, precisely when you least want that.
 *   2. read the token once.
 *   3. tenant access — are you signed in, and does the token list this club?
 *   4. permission — are you allowed to do THIS to it?
 *
 * Steps 3 and 4 are defence in depth, not the defence. Postgres RLS is the
 * guarantee: even if this file were deleted, a query bound to the wrong
 * tenant returns zero rows.
 *
 * ═══ WHAT THIS FILE CAN AND CANNOT DECIDE (#250) ═══
 *
 * It reads a token and never the database. A token can say "a member here,
 * with this role"; it cannot say "not a member here" — a native token lists no
 * clubs at all, and a web token lists only the clubs it was signed in with,
 * while #229 lets a player join one by booking. So:
 *
 *   anonymous on a tenant path       refused here (401, or a sign-in redirect)
 *   the token lists this club        let through; a mutation is refused here
 *                                    when the claimed role lacks the permission
 *   the token does not list it       let through UNDECIDED: the route resolves
 *                                    the membership from the database and
 *                                    enforces the same permission table itself
 *
 * The last row is not a gap. `contextFromRequest` refuses before any tenant
 * route's handler runs, and `tenant-routes-resolve-membership` fails the build
 * if a tenant route stops going through it.
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

/** `/t/{slug}` and nothing below it: a club's index, which the page routes by role. */
const CLUB_INDEX = /^\/t\/([^/]+)\/?$/;

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
      // A club's bare address, signed out: its public page (#356, audit A03),
      // not a sign-in wall. `/t/{slug}` was the URL people had for a club, and
      // it only ever said "sign in". A redirect, not an opening: everything
      // below `/t/{slug}/` still goes to sign-in, and the public page is its
      // own route with its own ACTIVE checks.
      const clubIndex = CLUB_INDEX.exec(pathname);
      if (clubIndex) {
        return NextResponse.redirect(new URL(`/clubs/${clubIndex[1]}`, req.url));
      }
      const login = new URL('/login', req.url);
      // The query string too: `/t/x/admin/calendar?day=2026-10-01` is a deep
      // link to that day, and dropping `?day=` lands on today. `/login` treats
      // this as a destination that wins over role landing (#227), and decides
      // there whether it is a safe one.
      login.searchParams.set('next', `${pathname}${req.nextUrl.search}`);
      return NextResponse.redirect(login);
    }

    case 'needs_db_check':
      // Signed in, and the token does not list this club: a native token
      // (which lists none), a club joined after sign-in (#229), or a list cut
      // at fifty. None of those says "not a member", and this file cannot ask
      // the database — so the request goes on, and the route asks.
      //
      // This used to be a 403 for every case but the last, which refused the
      // iOS client at its own club and refused #229's join-on-booking at the
      // club being joined (#250).
      break;
  }

  // 4. Permission on mutations — when the token has something to say.
  //
  // Derived from the membership matching THIS path, never from
  // `token.permissions` — which auth.ts freezes to memberships[0], the club
  // joined first. Reading that array here let an OWNER at one club perform
  // owner-only mutations at every other club they had merely joined.
  //
  // Skipped on `needs_db_check`, where there is no claim to derive it from.
  // Skipping it does not ALLOW the mutation: `contextFromRequest` looks up the
  // same `requiredPermission` and checks it against the role the database holds
  // for this caller at this club, and a caller with no membership there is
  // refused outright — except on the one route that exists to create it.
  const needed = requiredPermission(pathname, req.method);
  if (needed && access.kind !== 'needs_db_check') {
    const perms = permissionsForPath(pathname, token);
    if (!perms.includes(needed)) {
      return apiError(403, 'FORBIDDEN', 'Forbidden', { requiredPermission: needed });
    }
  }

  return withLocaleCookie(NextResponse.next(), req, token);
}

/**
 * Seed the locale cookie from the signed-in user's stored preference.
 *
 * `User.locale` has existed since P05, defaulting to `bg`, and drove NOTHING:
 * the next-intl request config hardcoded its locale and read no cookie, so a
 * user who set English got Bulgarian anyway, for ever.
 *
 * Seeded here rather than read per-request in the request config, because that
 * config runs on every render and a database round trip there would be on the
 * critical path of the first byte. The token already carries the value.
 *
 * Only written when it DIFFERS from what the browser sent — a `Set-Cookie` on
 * every response is a cache-defeating header on otherwise static pages.
 *
 * Never written for an anonymous request: the absence of the cookie is what
 * makes the default apply, and stamping `bg` on a first visit would make a
 * later change of the default silently not reach anyone who had ever visited.
 */
function withLocaleCookie(
  res: NextResponse,
  req: NextRequest,
  token: TokenClaims | null,
): NextResponse {
  if (!token?.locale || !isLocale(token.locale)) return res;
  if (req.cookies.get(LOCALE_COOKIE)?.value === token.locale) return res;

  res.cookies.set(LOCALE_COOKIE, token.locale, {
    // Read by the server on the next request, and by the language switcher.
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });

  return res;
}

export const config = {
  matcher: [
    // Everything except Next internals and static assets. A matcher that
    // accidentally excludes /api/** is the classic way to ship a guard that
    // protects the pages and leaves the data open.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|css|js)$).*)',
  ],
};
