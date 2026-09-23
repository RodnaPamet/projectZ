/**
 * Fetching a user's Entra groups from Microsoft Graph.
 *
 * ═══ WHY THIS EXISTS AT ALL ═══
 *
 * Entra omits the `groups` claim entirely for a user in more than roughly 200
 * groups, substituting `_claim_names.groups` — an "ask Graph" pointer. At a
 * large customer that is not an edge case, it is every employee. Without this
 * path their group list is empty and they silently get no role.
 *
 * ═══ WHY IT IS NOT A COPY OF THE ONE IT IS PORTED FROM ═══
 *
 * The implementation this is based on has no timeout, no retry, and a
 * 20-page ceiling it crosses SILENTLY — returning a truncated list through
 * the same `return` as a complete one. Three consequences, all of which land
 * on a real person trying to sign in:
 *
 *   - no timeout, on a call inside the sign-in path, makes Graph availability
 *     a hard dependency of authentication with no bound on how long a user
 *     waits;
 *   - no retry turns one 429 — which Graph issues routinely — into a wrong
 *     answer rather than a slow one;
 *   - and a silently truncated list is INDISTINGUISHABLE from a complete one,
 *     so the caller cannot tell "this user is in no mapped group" from "we
 *     stopped looking". With the group gate enforced, those two produce the
 *     same outcome for the user — denied — from opposite facts.
 *
 * So: every request is bounded, the whole operation is bounded, transient
 * failures are retried with full jitter, and `complete` reports whether the
 * answer can be trusted. The caller decides what to do with an incomplete
 * one; it is never dressed up as an empty one.
 */

/** One page. `$top=999` is Graph's maximum. */
const GRAPH_MEMBER_OF =
  'https://graph.microsoft.com/v1.0/me/memberOf/microsoft.graph.group?$select=id&$top=999';

/**
 * The OData type-cast segment (`/microsoft.graph.group`) filters server-side
 * to groups. Without it the response also carries directory roles and
 * administrative units, whose ids would then be matched against group
 * mappings — a mapping could be satisfied by holding a DIRECTORY ROLE.
 */

const REQUEST_TIMEOUT_MS = 4_000;
/** The whole operation, across every page and retry. This runs inside sign-in. */
const TOTAL_BUDGET_MS = 10_000;
const MAX_PAGES = 20;
const MAX_ATTEMPTS = 3;

export interface GraphGroupsResult {
  groups: string[];
  /**
   * False when the full set could not be established — a timeout, an
   * exhausted retry, or more pages than MAX_PAGES. `groups` may still hold a
   * partial list; it must not be treated as exhaustive.
   */
  complete: boolean;
  reason?: 'timeout' | 'budget' | 'http' | 'network' | 'too-many-pages';
}

type FetchImpl = typeof fetch;

interface GraphPage {
  value?: Array<{ id?: string }>;
  '@odata.nextLink'?: string;
}

/** Full jitter: random over the whole window, not a fixed step plus noise. */
function backoffMs(attempt: number, random: () => number): number {
  return Math.floor(random() * Math.min(1_000 * 2 ** attempt, 4_000));
}

function retryable(status: number): boolean {
  // 429 is Graph's normal throttling signal and 5xx is transient by
  // definition. A 401/403 is not: the token is wrong, and retrying it just
  // spends the user's patience arriving at the same answer.
  return status === 429 || status >= 500;
}

export async function fetchUserGroupsFromGraph(
  accessToken: string,
  deps: {
    fetchImpl?: FetchImpl;
    now?: () => number;
    random?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<GraphGroupsResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const deadline = now() + TOTAL_BUDGET_MS;
  const groups: string[] = [];

  let url: string | undefined = GRAPH_MEMBER_OF;
  let pages = 0;

  while (url) {
    if (pages >= MAX_PAGES) {
      return { groups, complete: false, reason: 'too-many-pages' };
    }
    if (now() >= deadline) {
      return { groups, complete: false, reason: 'budget' };
    }

    let page: GraphPage | null = null;
    let lastReason: GraphGroupsResult['reason'] = 'network';

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (now() >= deadline) return { groups, complete: false, reason: 'budget' };

      try {
        // Clamped to what is LEFT of the budget, not a flat 4s. Checking the
        // deadline only before issuing a request means the last request can
        // still run its full timeout past it — so a "10 second" budget was
        // really 14.
        const remaining = deadline - now();
        if (remaining <= 0) return { groups, complete: false, reason: 'budget' };

        const res = await doFetch(url, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
        });

        if (res.ok) {
          const body = (await res.json().catch(() => null)) as GraphPage | null;

          // A 200 carrying something that is not a Graph collection — an HTML
          // error page from a proxy, a changed API shape, an empty body — used
          // to fall through the normal path and return `{ groups: [],
          // complete: true }`. That is the precise failure this module exists
          // to prevent: "we do not know" dressed up as "no groups".
          if (!body || !Array.isArray(body.value)) {
            return { groups, complete: false, reason: 'http' };
          }

          page = body;
          break;
        }

        if (!retryable(res.status)) {
          return { groups, complete: false, reason: 'http' };
        }

        lastReason = 'http';

        // Graph tells us how long to wait when it throttles. Ignoring it and
        // backing off on our own schedule is how a throttle becomes a
        // thundering herd.
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1_000, 4_000)
            : backoffMs(attempt, random);

        if (now() + wait >= deadline) return { groups, complete: false, reason: 'budget' };
        await sleep(wait);
      } catch (err) {
        // AbortSignal.timeout rejects with a TimeoutError; everything else
        // here is a transport failure. Both are worth one more try.
        lastReason = (err as Error)?.name === 'TimeoutError' ? 'timeout' : 'network';
        if (attempt === MAX_ATTEMPTS - 1) break;
        const wait = backoffMs(attempt, random);
        if (now() + wait >= deadline) return { groups, complete: false, reason: 'budget' };
        await sleep(wait);
      }
    }

    if (!page) return { groups, complete: false, reason: lastReason };

    for (const entry of page.value ?? []) {
      if (typeof entry.id === 'string') groups.push(entry.id);
    }

    url = page['@odata.nextLink'];
    pages++;
  }

  return { groups, complete: true };
}
