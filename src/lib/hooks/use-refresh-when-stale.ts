'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * How old a live screen's payload may be before it re-fetches itself.
 *
 * 10 s, well inside `staleTimes.dynamic` (30 s, next.config.mjs). The router
 * cache is what makes a revisit instant (#290): the cached diary paints with
 * no round trip and no skeleton. But the diary is the front desk's live view,
 * and a booking taken on a phone 20 s ago must not stay invisible for the rest
 * of the window. So a cached diary paints at once, and if what it painted is
 * older than this it asks the server again, in the background, keeping the
 * cached grid on screen until the fresh one replaces it.
 *
 * Below 10 s the refresh would fire on nearly every revisit, and each one
 * purges the WHOLE client cache (Next 16.3.6's refresh-reducer bumps one
 * global segment-cache version), taking every other cached admin screen with
 * it. Above it, the diary can be most of a staleTimes window old.
 */
export const STALE_AFTER_MS = 10_000;

/**
 * When THIS browser first showed each payload, keyed by the server's render
 * time.
 *
 * ═══ WHY NOT `Date.now() - renderedAt` ═══
 *
 * Because that subtracts two different clocks. A phone whose clock runs 15 s
 * ahead of the server would find every diary stale the instant it mounted, and
 * refresh (purging the router cache) on every visit; one running behind would
 * never refresh at all. The server's timestamp identifies the payload; its age
 * is measured on the client's own clock, from the moment it was first shown.
 * A fresh navigation shows its payload within one round trip of the render,
 * so the two agree to within that round trip.
 *
 * Module state, on purpose: a cached payload remounts (a revisit inside the
 * staleTimes window, the back button) with its original `renderedAt`, and has
 * to be recognised as the one shown 25 s ago.
 */
const firstSeen = new Map<number, number>();
/** The last refresh this hook asked for, per payload. One per payload per window, never a loop. */
const refreshedAt = new Map<number, number>();
/** A tab left open all day sees thousands of payloads; only the recent ones can remount. */
const MAX_TRACKED = 64;

function remember(map: Map<number, number>, key: number, value: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED) map.delete(map.keys().next().value!);
}

/**
 * Re-fetch the current route when the payload on screen is older than
 * `staleAfterMs`: checked on mount, and whenever the tab becomes visible again
 * (a front-desk tablet woken after lunch).
 *
 * `renderedAt` is `Date.now()` taken by the server component that rendered the
 * payload, passed down as a prop. `router.refresh()` is a transition: the
 * stale content stays on screen, and no loading.tsx fallback is shown.
 */
export function useRefreshWhenStale(renderedAt: number, staleAfterMs = STALE_AFTER_MS): void {
  const router = useRouter();

  useEffect(() => {
    if (!firstSeen.has(renderedAt)) remember(firstSeen, renderedAt, Date.now());

    const refreshIfStale = () => {
      const now = Date.now();
      const age = now - firstSeen.get(renderedAt)!;
      if (age <= staleAfterMs) return;
      const last = refreshedAt.get(renderedAt);
      // A refresh that failed (offline) leaves the same payload on screen; it
      // may try again, but not more often than once per window.
      if (last != null && now - last <= staleAfterMs) return;
      remember(refreshedAt, renderedAt, now);
      router.refresh();
    };

    refreshIfStale();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshIfStale();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [renderedAt, staleAfterMs, router]);
}
