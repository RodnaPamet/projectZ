'use client';

import Link from 'next/link';
import { type ComponentProps, useSyncExternalStore } from 'react';

/**
 * A link to a PUBLIC page that is fully prefetched, unless the browser asks
 * to save data (docs/perf/navigation-policy.md, "Prefetching").
 *
 * ═══ WHY FULL PREFETCH HERE, AND NOWHERE ELSE ═══
 *
 * Measured on production (#290): a first visit to /venues or /login showed
 * its skeleton at 10–60 ms, had the whole RSC answer by 73–112 ms, and then
 * waited for React's 300 ms Suspense reveal throttle, so content painted at
 * 322–362 ms. A fully prefetched route is already in the router cache on the
 * tap: no request, no fallback, so no throttle. These payloads are 1.4–2.4 KB
 * and the same for every anonymous visitor, so fetching them ahead costs
 * nearly nothing and is never stale in a way that matters.
 *
 * The club admin does NOT do this: a fully prefetched diary could be 180 s
 * old on the tap, and every admin write would re-prefetch each such link in
 * full. tests/guardrails/router-cache-policy.test.ts allow-lists this file
 * and pins where it is used.
 *
 * ═══ SAVE-DATA ═══
 *
 * Under `navigator.connection.saveData` it falls back to the default (auto)
 * prefetch. The server cannot know, so the server render assumes Save-Data
 * (auto) and the client switches to full after hydration: a Save-Data
 * browser never starts a full prefetch.
 */
type Props = Omit<ComponentProps<typeof Link>, 'prefetch'>;

function subscribe(onChange: () => void) {
  const c = connection();
  c?.addEventListener?.('change', onChange);
  return () => c?.removeEventListener?.('change', onChange);
}

function connection(): (EventTarget & { saveData?: boolean }) | undefined {
  return (navigator as Navigator & { connection?: EventTarget & { saveData?: boolean } })
    .connection;
}

const saveDataNow = () => connection()?.saveData === true;
const saveDataOnServer = () => true;

export function PublicPrefetchLink(props: Props) {
  const saveData = useSyncExternalStore(subscribe, saveDataNow, saveDataOnServer);
  return <Link {...props} prefetch={saveData ? null : true} />;
}
