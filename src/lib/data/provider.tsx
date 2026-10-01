'use client';

import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { SWRConfig, type Middleware, type SWRConfiguration } from 'swr';

import { isSessionExpired, noteUnauthorized, subscribe } from '@/lib/auth/session-expiry';

import { isApiClientError } from './errors';
import { isViewerChanged, noteViewerChanged, subscribeViewerChanged } from './viewer';

/**
 * The app-wide SWR configuration, and the two seams that stop it.
 *
 * ═══ WHY THE SEAM IS MIDDLEWARE, NOT A CONFIG VALUE ═══
 *
 * inflect puts its session-expiry overrides into the `<SWRConfig value>`. SWR
 * merges a hook's own options OVER the provider's, so any hook that sets
 * `revalidateOnFocus: true` — and `useV1SWR` sets it by default — wins against
 * the seam, and every tab focus after expiry restarts the 401 burst the seam
 * was written to stop (measured in this repo's review as V14). A middleware
 * receives the config AFTER that merge, so its overrides are the last word.
 *
 * Once the session has expired or the viewer changed, every hook gets:
 *   refreshInterval 0, revalidateOnFocus / OnReconnect / IfStale false,
 *   shouldRetryOnError false.
 * Nothing new STARTS. `isPaused` is deliberately not used: inflect measured
 * that SWR also checks it inside its catch and then DISCARDS the error, so a
 * hook mounting after expiry would render neither data nor error.
 *
 * Both stores are module-scope and read with `useSyncExternalStore`, so a write
 * from a fetch that resolved before any component subscribed is still seen.
 *
 * ═══ NEVER A PERSISTENT CACHE ═══
 *
 * No `provider` here: SWR's default cache is an in-memory Map that dies with
 * the tab. A localStorage- or IndexedDB-backed cache is per DEVICE, and would
 * serve the previous account's bookings to the next person on a shared phone —
 * the service-worker rule in tests/guardrails/pwa-safety.test.ts, which now
 * covers SWR too.
 */

const STOPPED: Partial<SWRConfiguration> = {
  refreshInterval: 0,
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  revalidateIfStale: false,
  shouldRetryOnError: false,
};

function subscribeStopped(onChange: () => void): () => void {
  const a = subscribe(onChange);
  const b = subscribeViewerChanged(onChange);
  return () => {
    a();
    b();
  };
}

const isStopped = () => isSessionExpired() || isViewerChanged();
const serverSnapshot = () => false;

/** Read the combined "stop fetching" flag. Exported for the notices and tests. */
export function useDataStopped(): boolean {
  return useSyncExternalStore(subscribeStopped, isStopped, serverSnapshot);
}

export const sessionSeam: Middleware = (useSWRNext) => (key, fetcher, config) => {
  // A hook, called unconditionally on every render of every SWR hook — the
  // middleware runs inside the hook, so the rules of hooks hold.
  const stopped = useDataStopped();
  const inner = config.onErrorRetry;
  const onErrorRetry: SWRConfiguration['onErrorRetry'] = (err, k, cfg, revalidate, opts) => {
    if (!inner || isStopped()) return;
    inner(err, k, cfg, (o) => (isStopped() ? undefined : revalidate(o)), opts);
  };
  return useSWRNext(key, fetcher, {
    ...config,
    ...(stopped ? STOPPED : {}),
    // The one path the overrides above cannot reach: a retry that was already
    // SCHEDULED. SWR decides to retry when a request fails and then just sets a
    // timer (2–6 s out with our interval); when it fires, it revalidates without
    // consulting revalidateOnFocus, shouldRetryOnError or anything else above.
    // So a 503 followed, before its retry, by another hook's 401 still sent the
    // retry's GET: 2 GETs instead of 1 in tests/rendered/data-hooks ("a retry
    // scheduled BEFORE the session expired") without this. The stores are
    // checked when the retry is scheduled and again when it fires.
    // Not the seam itself (inflect's caution: SWR skips this hook entirely when
    // shouldRetryOnError is false) — a second lock behind it.
    onErrorRetry,
  });
};

/** `$inf$/api/v1/…` → `/api/v1/…`, so the path check sees the real URL. */
const urlOf = (key: unknown) =>
  typeof key === 'string' ? key.replace(/^\$(?:inf|sub)\$/, '') : undefined;

/**
 * The second writer. `v1Fetch` already marks both stores; this catches a hook
 * given some other fetcher that still throws `ApiClientError`. Idempotent.
 */
function onError(err: unknown, key: unknown) {
  if (!isApiClientError(err)) return;
  noteUnauthorized(err.status, urlOf(key));
  if (err.status === 409 && err.code === 'VIEWER_CHANGED') noteViewerChanged();
}

const VALUE: SWRConfiguration = { use: [sessionSeam], onError };

export function DataProvider({ children }: { children: ReactNode }) {
  return <SWRConfig value={VALUE}>{children}</SWRConfig>;
}

const ViewerContext = createContext<string | null>(null);

/**
 * The user id the page was rendered for, given to every v1 call beneath it as
 * `x-playerz-viewer` (see src/app/api/v1/_lib/request-guard.ts). A page that
 * shows a person's own data wraps it; a public page does not need to.
 */
export function ViewerScope({ viewerId, children }: { viewerId: string; children: ReactNode }) {
  return <ViewerContext.Provider value={viewerId}>{children}</ViewerContext.Provider>;
}

export function useViewerId(): string | null {
  return useContext(ViewerContext);
}
