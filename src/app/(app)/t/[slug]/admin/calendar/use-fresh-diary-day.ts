'use client';

import { useState } from 'react';

import { useRefreshWhenStale } from '@/lib/hooks/use-refresh-when-stale';

import { refreshDiaryDayAction } from './actions';
import type { DiaryDay } from './diary-day';

/**
 * The newest copy of each day this tab has fetched for itself, per club and
 * `?day=`.
 *
 * A revisit inside the router-cache window (30 s) remounts the grid with the
 * CACHED server payload, which is older than a copy this hook fetched since.
 * Without this, the grid would paint the older copy, find it stale and fetch
 * again; with it, the revisit paints the newest copy the tab has and measures
 * its age from that one. Module state for the same reason as the hook's own:
 * it has to survive the unmount. The cache never outlives the tab, and a
 * sign-out is a full page load.
 */
const latest = new Map<string, DiaryDay>();
const MAX_DAYS = 16;

const keyOf = (slug: string, requestedDay: string | null) => `${slug}\n${requestedDay ?? ''}`;

function remember(key: string, day: DiaryDay) {
  const prev = latest.get(key);
  if (prev && prev.renderedAt >= day.renderedAt) return;
  latest.delete(key);
  latest.set(key, day);
  while (latest.size > MAX_DAYS) latest.delete(latest.keys().next().value!);
}

/**
 * The day to draw: the server's payload, or a newer copy fetched since.
 *
 * ═══ WHY NOT router.refresh() (#314) ═══
 *
 * A stale diary used to call `router.refresh()`. In Next 16.3.6 that purges
 * the whole client router cache, so every diary revisit after 10 s turned
 * every other warm admin screen cold (calendar → courts: 46 → 357 ms on the
 * phone). Re-fetching only the day, through a server action that revalidates
 * nothing (actions.ts, `refreshDiaryDayAction`), leaves the router cache
 * alone: the other screens stay warm, and only the grid's data is replaced.
 *
 * The grid also calls the returned `refresh` after a desk booking or a cancel
 * (#364), which go through /api/v1 and leave the router none the wiser.
 *
 * Newer always wins, by the server's `renderedAt`: a write that revalidates
 * the diary (a no-show) sends a fresh server payload, which then beats any
 * copy fetched before it. A refresh that fails keeps what is on screen; the
 * hook tries again at most once per window.
 */
export function useFreshDiaryDay(
  slug: string,
  requestedDay: string | null,
  serverDay: DiaryDay,
): { day: DiaryDay; refresh: () => void } {
  const key = keyOf(slug, requestedDay);
  const [fetched, setFetched] = useState<{ key: string; day: DiaryDay } | null>(null);

  const own = fetched?.key === key ? fetched.day : undefined;
  const remembered = latest.get(key);
  const newest = [serverDay, own, remembered].reduce<DiaryDay>(
    (a, b) => (b && b.renderedAt > a.renderedAt ? b : a),
    serverDay,
  );

  // A plain function: the hook keeps the latest one in a ref.
  const refresh = () => {
    refreshDiaryDayAction(slug, requestedDay).then(
      (day) => {
        remember(key, day);
        setFetched({ key, day });
      },
      () => {
        // Offline, signed out, or no longer allowed: keep the grid on screen.
        // A signed-out tab is told so by the session-expiry notice, not here.
      },
    );
  };

  useRefreshWhenStale(newest.renderedAt, refresh);
  // `refresh` is also the grid's own after a desk write (#364): the write goes
  // to /api/v1, which the router cannot see, so the day is fetched again the
  // same way a stale one is — the router cache stays intact.
  return { day: newest, refresh };
}
