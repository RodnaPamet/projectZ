import { noteUnauthorized } from '@/lib/auth/session-expiry';

import { ApiClientError } from './errors';
import { noteViewerChanged } from './viewer';

/**
 * `v1Fetch` — the one way browser code talks to `/api/v1`.
 *
 * It exists so that four things are true of EVERY call rather than of the ones
 * somebody remembered:
 *
 *   1. The success envelope is unwrapped. v1 answers `{ data }` (envelope.ts),
 *      so a caller gets `T`, and a 204 or an empty body gets `undefined`
 *      rather than a JSON parse error on a delete that worked.
 *   2. A failure throws `ApiClientError` with `status`, `code`, `requestId` and
 *      `details` as properties — see errors.ts for why the status may never
 *      live only in a message.
 *   3. A 401 from a session-bearing path marks the session expired
 *      (`noteUnauthorized`, vendored from inflect: it ignores `/api/auth/**`,
 *      where a 401 is about the sign-in being attempted, not a lapsed session),
 *      and a 409 VIEWER_CHANGED marks the viewer changed. The SWR provider
 *      reads both stores and stops every revalidation.
 *   4. The page's user id rides along as `x-playerz-viewer` when the caller has
 *      one (ViewerScope), so the server can refuse to answer for a different
 *      account than the page was rendered for.
 *
 * `idempotencyKey` sets `Idempotency-Key`, which POST /bookings requires;
 * `signal` is passed through so SWR and unmounts can cancel.
 */

export interface V1FetchInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** A plain value is sent as JSON. */
  body?: unknown;
  /** The user id the page was rendered for — sent as `x-playerz-viewer`. */
  viewerId?: string | null;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

interface ErrorEnvelope {
  error?: { code?: unknown; message?: unknown; requestId?: unknown; details?: unknown };
}

async function readJson(res: Response): Promise<unknown> {
  // `res.json()` on an empty body throws, and "the delete worked" must not
  // surface as a SyntaxError. Read the text once and decide.
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function v1Fetch<T>(url: string, init: V1FetchInit = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  if (init.viewerId) headers['x-playerz-viewer'] = init.viewerId;
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body,
      signal: init.signal,
      // Same-origin is fetch's default; spelled out because the session cookie
      // is the credential and the server's cross-site check relies on the
      // browser's own Sec-Fetch-Site, which only same-origin earns.
      credentials: 'same-origin',
      // No HTTP caching of personal data: SWR is the cache, and it is in memory.
      cache: 'no-store',
    });
  } catch (err) {
    // DOMException is not an `Error` in every runtime (jsdom's is not), so the
    // abort is recognised by name.
    if ((err as { name?: unknown } | null)?.name === 'AbortError') throw err;
    throw new ApiClientError({
      status: 0,
      code: 'NETWORK',
      message: err instanceof Error ? err.message : 'Network request failed',
    });
  }

  if (res.status === 204) return undefined as T;

  const parsed = await readJson(res);

  if (!res.ok) {
    const envelope = (parsed ?? {}) as ErrorEnvelope;
    const e = envelope.error ?? {};
    const code = typeof e.code === 'string' ? e.code : 'UNKNOWN';
    const requestId =
      typeof e.requestId === 'string' ? e.requestId : res.headers.get('x-request-id');

    noteUnauthorized(res.status, url);
    if (res.status === 409 && code === 'VIEWER_CHANGED') noteViewerChanged();

    throw new ApiClientError({
      status: res.status,
      code,
      message: typeof e.message === 'string' ? e.message : `HTTP ${res.status}`,
      requestId,
      details: e.details,
    });
  }

  if (parsed === undefined) return undefined as T;
  return (parsed as { data?: T }).data as T;
}
