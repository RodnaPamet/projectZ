import type { NextRequest } from 'next/server';

/**
 * Two checks on WHO is really making a v1 request, made where the caller is
 * resolved (`contextFromRequest`), before any handler runs.
 *
 * ═══ 1. A COOKIE-AUTHENTICATED WRITE MUST COME FROM OUR OWN PAGES ═══
 *
 * Until the client data layer (src/lib/data) every browser write went through a
 * Server Action, and Next refuses a Server Action whose `Origin` does not match
 * the host — CSRF protection nobody in this repo wrote, and therefore nobody
 * could see. Moving a web write to `fetch('/api/v1/…', { method: 'POST' })`
 * loses it: the session cookie rides along on the POST and neither the edge
 * middleware, `guard.ts`, nor anything under `_lib` looked at where the request
 * came from (searched for `Sec-Fetch-Site` and `Origin` on 2026-10-01: zero).
 *
 * SameSite=Lax on next-auth's cookie covers a different site, but not a
 * different ORIGIN on the same site: `evil.playerz.bg`, or any subdomain a
 * future integration hands out, is "same-site", and Lax sends the cookie.
 *
 * So: a mutation (POST, PUT, PATCH, DELETE) that CARRIES THE SESSION COOKIE is
 * refused with 403 CROSS_SITE_REQUEST when the browser says, in
 * `Sec-Fetch-Site`, that it did not come from this origin. Every browser that
 * can run this app sends the header on every fetch; it is a forbidden header
 * name, so a page cannot forge or strip it.
 *
 * Deliberately unaffected:
 *   - `Bearer` requests with no session cookie. The native client authenticates
 *     with a token it holds; a token is not ambient, so nobody can make a
 *     victim's app send it. That is the whole reason CSRF is a cookie problem.
 *   - A request with NO `Sec-Fetch-Site` at all — curl, the native client, a
 *     server-to-server call, an old browser. Refusing those would break real
 *     clients to defend against nothing: an attacker cannot make a victim's
 *     modern browser omit the header.
 *   - `none` — a user-initiated navigation (typed URL, bookmark). A fetch never
 *     sends it, but a top-level form POST the user caused can.
 *   - Reads. A GET changes nothing, and the cross-origin read is already stopped
 *     by the absence of CORS headers.
 *
 * ═══ 2. THE PAGE WAS RENDERED FOR ONE ACCOUNT; THE COOKIE MAY NOW BE ANOTHER ═══
 *
 * #263 makes two accounts per person routine (a player account and a club
 * account), and both live in the same browser jar, one at a time. Player data
 * keys carry no user id — `/api/v1/t/{slug}/bookings` means "mine", whoever I
 * am — so a tab rendered for account A, after a sign-in as B in another tab,
 * would fetch B's bookings under A's page and cache them as A's.
 *
 * The client therefore sends `x-playerz-viewer: <the user id the page was
 * rendered for>`, and a request whose authenticated user differs is refused
 * with 409 VIEWER_CHANGED. 409 because the request was fine and the world
 * moved: the cure is a reload, which renders the page for whoever is signed in
 * now. The client data layer stops revalidating on it (src/lib/data/provider).
 *
 * A request with no header is unaffected (native, curl, the server's own
 * fetches). A signed-OUT caller is not a viewer change either: that is the
 * route's own 401, which the session-expiry seam already handles.
 */

/** The request header the web client puts the page's user id in. */
export const VIEWER_HEADER = 'x-playerz-viewer';

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * next-auth v4's session cookie: `next-auth.session-token`, `__Secure-` on
 * HTTPS, and `.0`, `.1`, … when a large token is chunked. Any of them means the
 * browser attached ambient credentials to this request.
 */
const SESSION_COOKIE = /^(?:__Secure-)?next-auth\.session-token(?:\.\d+)?$/;

/** Sec-Fetch-Site values that mean "this origin, or the user typed it". */
const OWN_ORIGIN = new Set(['same-origin', 'none']);

export class CrossSiteRequestError extends Error {
  constructor(site: string) {
    super(
      `Refused a cookie-authenticated write with Sec-Fetch-Site: ${site}. Session-cookie ` +
        'writes to /api/v1 must come from this origin; a native client authenticates with a Bearer token.',
    );
    this.name = 'CrossSiteRequestError';
  }
}

export class ViewerChangedError extends Error {
  constructor() {
    super(
      'The page was rendered for a different account than the one signed in now. Reload the page.',
    );
    this.name = 'ViewerChangedError';
  }
}

type GuardedRequest = Pick<NextRequest, 'method' | 'headers' | 'cookies'>;

function carriesSessionCookie(req: GuardedRequest): boolean {
  return req.cookies.getAll().some((c) => SESSION_COOKIE.test(c.name));
}

/** Throws CrossSiteRequestError for a cookie-authenticated write from another origin. */
export function assertOwnOriginForCookieWrites(req: GuardedRequest): void {
  if (!MUTATIONS.has(req.method.toUpperCase())) return;
  const site = req.headers.get('sec-fetch-site');
  if (site === null || OWN_ORIGIN.has(site)) return;
  if (!carriesSessionCookie(req)) return;
  throw new CrossSiteRequestError(site);
}

/**
 * Throws ViewerChangedError when the page's viewer is not the authenticated
 * user. `userId` null (anonymous, or a revoked session) is left to the route.
 */
export function assertViewer(req: GuardedRequest, userId: string | null): void {
  const viewer = req.headers.get(VIEWER_HEADER);
  if (viewer === null || viewer === '' || userId === null) return;
  if (viewer !== userId) throw new ViewerChangedError();
}
