'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

import { PullToRefresh } from './PullToRefresh';
import { ScrollToTop } from './ScrollToTop';

/**
 * The two affordances every long list page wants, in one client island.
 *
 * ─── What a pull refreshes ───────────────────────────────────────────
 *
 * It depends on where the list's data lives, so the caller says:
 *
 *   - A list read through SWR (the player surfaces, on /api/v1) passes
 *     `onRefresh={() => mutate()}`. Its rows are in the client cache, and
 *     `router.refresh()` would re-render the server component around them
 *     while the list itself kept showing the cached rows — a pull that
 *     fetched something and changed nothing.
 *   - A list rendered by a SERVER COMPONENT (club admin, RSC + Server
 *     Actions) has no SWR key and nothing to mutate, so the default is
 *     `router.refresh()`: it re-runs the server component and streams the new
 *     markup in, keeping client state and scroll position.
 *
 * Either way the indicator is held for at least 400 ms. `router.refresh()`
 * is fire-and-forget, and a cached SWR revalidation can settle within a
 * frame: without a floor the spinner appears and vanishes before the eye
 * catches it, the pull seems not to have registered, and the person pulls
 * again.
 */
export function MobileListAffordances({
  onRefresh,
}: {
  /** What a pull re-reads. Defaults to `router.refresh()`; see above. */
  onRefresh?: () => Promise<unknown> | void;
} = {}) {
  const router = useRouter();

  const refresh = useCallback(async () => {
    const floor = new Promise((resolve) => setTimeout(resolve, 400));
    if (onRefresh) await Promise.all([onRefresh(), floor]);
    else {
      router.refresh();
      await floor;
    }
  }, [onRefresh, router]);

  return (
    <>
      <PullToRefresh onRefresh={refresh} />
      <ScrollToTop />
    </>
  );
}
