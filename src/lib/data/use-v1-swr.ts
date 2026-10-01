'use client';

import { useCallback } from 'react';
import useSWR, { type SWRConfiguration } from 'swr';
import useSWRInfinite, { type SWRInfiniteConfiguration } from 'swr/infinite';

import type { ApiClientError } from './errors';
import { v1Fetch } from './fetcher';
import type { InfiniteKey, V1Page } from './keys';
import { useViewerId } from './provider';

/**
 * Reads from `/api/v1`, through SWR, with the repo's defaults.
 *
 * ═══ THE DEFAULTS, AND WHY EACH ═══
 *
 *   revalidateOnFocus / OnReconnect  on: a player comes back to the tab and
 *                                    expects today's bookings, not this
 *                                    morning's. The session seam turns both
 *                                    off once the session or viewer is gone.
 *   dedupingInterval 5000            SWR's 2 s lets a quick tab-in/tab-out pair
 *                                    fire twice; 5 s is one read per glance.
 *   errorRetryCount 2, 2000 ms       a blip on mobile data recovers; a real
 *                                    outage stops after two retries (SWR's
 *                                    backoff puts them 2–6 s and 4–12 s out)
 *                                    instead of retrying for as long as the
 *                                    tab is open, which is SWR's default.
 *   keepPreviousData                 a filter change keeps the old list on
 *                                    screen until the new one lands, rather
 *                                    than flashing a skeleton every keystroke.
 *
 * Any of them can be overridden per hook — except by the seam, which runs as
 * middleware after the merge (provider.tsx).
 *
 * ═══ `audited: true` ═══
 *
 * Some reads are themselves recorded. Every page of the moderation queue writes
 * a PLATFORM_MODERATION_QUEUE_READ row with the reason the moderator gave, so a
 * read SWR starts on its own — a focus, a reconnect, a stale remount, a retry,
 * the first page re-checked on load-more — is an audit row nobody asked for,
 * attributed to a person who did not make it. `audited` turns all of those off,
 * and it wins over the caller's own options: a read is fetched when a person
 * asks for it, and at no other time.
 *
 * ═══ SKELETONS ═══
 *
 * `needsSkeleton` is true only on a FIRST load — loading with nothing to show.
 * A revalidation with data on screen is not a reason to blank it.
 */

const DEFAULTS = {
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  dedupingInterval: 5000,
  errorRetryCount: 2,
  errorRetryInterval: 2000,
  keepPreviousData: true,
} as const satisfies SWRConfiguration;

const AUDITED = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  revalidateIfStale: false,
  refreshInterval: 0,
  shouldRetryOnError: false,
} as const satisfies SWRConfiguration;

export interface V1SWROptions<T> extends SWRConfiguration<T, ApiClientError> {
  /** The read is audited server-side: SWR never starts one on its own. See above. */
  audited?: boolean;
}

export interface V1SWRInfiniteOptions<T> extends SWRInfiniteConfiguration<
  V1Page<T>,
  ApiClientError
> {
  audited?: boolean;
}

/** True only when there is nothing to show yet. */
export function needsSkeleton(state: { isLoading: boolean; data: unknown }): boolean {
  return state.isLoading && state.data === undefined;
}

function useV1Fetcher<T>() {
  const viewerId = useViewerId();
  return useCallback((url: string) => v1Fetch<T>(url, { viewerId }), [viewerId]);
}

export function useV1SWR<T>(key: string | null, options: V1SWROptions<T> = {}) {
  const { audited, ...rest } = options;
  const fetcher = useV1Fetcher<T>();
  return useSWR<T, ApiClientError>(key, fetcher, {
    ...DEFAULTS,
    ...rest,
    ...(audited ? AUDITED : {}),
  });
}

/** No list yet — e.g. the moderation queue before a reason is given. */
const NO_KEY = () => null;

export function useV1SWRInfinite<T>(
  getKey: InfiniteKey<T> | null,
  options: V1SWRInfiniteOptions<T> = {},
) {
  const { audited, ...rest } = options;
  const fetcher = useV1Fetcher<V1Page<T>>();
  return useSWRInfinite<V1Page<T>, ApiClientError>(getKey ?? NO_KEY, fetcher, {
    ...DEFAULTS,
    ...rest,
    // `revalidateFirstPage` is infinite-only: by default every load-more and
    // every revalidation re-fetches page 0 as well — one extra audited read per
    // "show more".
    ...(audited ? { ...AUDITED, revalidateFirstPage: false } : {}),
  });
}
