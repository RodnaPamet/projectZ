import { LEGAL_HREF } from '@/lib/legal/slugs';
import {
  LEGAL_STEP_PATH,
  currentLegalVersions,
  decodeLegalVersions,
  legalDocumentsDue,
  type LegalVersions,
} from '@/lib/legal/versions';

/**
 * A step a signed-in account owes before anything else (#462).
 *
 * Today there is one: the terms or the privacy policy changed, and the account
 * accepts the new version once. The middleware asks this on every page it is
 * about to serve and redirects to the step, with the way back.
 *
 * ═══ A HINT, NOT A DECISION ═══
 *
 * It reads the token and the versions bundled with the build, never the
 * database. A token that says "accepted" may be stale the other way too (the
 * person accepted in another browser), so the step page (`/start/terms`)
 * reads the database first: with nothing due it refreshes the session and
 * sends the person on, without asking them anything.
 *
 * ═══ WHAT IS NEVER HELD BACK ═══
 *
 *   - the API (`/api/**`): a page that is not shown calls nothing, and a
 *     native client reads `GET /api/v1/me/legal-acceptance` and shows its own
 *     step;
 *   - the step itself and the rest of `/start`, `/login`;
 *   - the texts being accepted and the cookie policy;
 *   - `/me/profile` and `/delete-account`: a person who will not accept can
 *     still download their data and delete the account;
 *   - anything that is not a page: only a request for HTML, or the router's
 *     own fetch of a page, is redirected.
 */

const FREE_PREFIXES = [
  '/api/',
  '/start',
  '/login',
  ...Object.values(LEGAL_HREF),
  '/delete-account',
  '/me/profile',
  '/offline',
];

function isFree(pathname: string): boolean {
  return FREE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p.endsWith('/') ? p : `${p}/`),
  );
}

export interface OwedStepRequest {
  pathname: string;
  /** The query string, with its `?`, or empty. */
  search: string;
  method: string;
  /** The request's `Accept` header. */
  accept: string | null;
  /** True for the App Router's own page fetch (the `RSC` request header). */
  rsc: boolean;
}

/**
 * Where to send this request instead, or null to let it through.
 * `current` is a parameter for the tests; the middleware passes nothing.
 */
export function owedStep(
  req: OwedStepRequest,
  token: { sub?: string | null; legal?: string } | null,
  current: LegalVersions = currentLegalVersions(),
): string | null {
  if (!token?.sub) return null;
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  if (isFree(req.pathname)) return null;
  if (!req.rsc && !(req.accept ?? '').includes('text/html')) return null;

  if (legalDocumentsDue(current, decodeLegalVersions(token.legal)).length === 0) return null;
  return `${LEGAL_STEP_PATH}?next=${encodeURIComponent(`${req.pathname}${req.search}`)}`;
}
