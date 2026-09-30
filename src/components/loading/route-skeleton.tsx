import { useTranslations } from 'next-intl';

import { cn } from '@/lib/cn';

/**
 * The one wrapper every `loading.tsx` renders (#267 follow-up, T12).
 *
 * ═══ WHY IT EXISTS ═══
 *
 * PR #268's baseline found no loading UI in any of 1,280 client-side
 * navigations: a phone tap waited 190-540 ms with the previous page frozen on
 * screen, which reads as a missed tap and gets tapped again. Without a loading
 * boundary a default prefetch fetches only the route tree, so every tap waits
 * for the full server render before anything changes. A `loading.tsx` is
 * prefetched with the route, so the router can paint it on the tap itself.
 *
 * ═══ WHAT IT PROMISES ═══
 *
 * - `role="status"` + `aria-busy="true"`: a screen reader hears that the
 *   screen is loading instead of silence, and the perf harness's
 *   FEEDBACK_SELECTOR (tests/perf/agent.ts) counts it as loading UI.
 * - A visually hidden label from the catalogue (`common.loading`), never a
 *   bare "Loading…" in JSX: tests/guardrails/loading-states.test.ts holds
 *   every loading.tsx to this wrapper, and tests/rendered/route-skeleton.test.tsx
 *   renders each one.
 * - The bars themselves are the design system's `Skeleton` primitives, which
 *   are `aria-hidden`: a list of grey rectangles is noise to a screen reader.
 *
 * No `animate-fadeIn`, unlike the design system's page skeletons: it starts
 * at opacity 0, so the first frame after the tap would paint nothing, which
 * is the thing this exists to stop. Feedback has to be on the glass at once.
 *
 * A server component (no 'use client'): next-intl's `useTranslations` works in
 * both, and a loading state has no interactivity to hydrate.
 *
 * It deliberately renders NO `main h1`. The harness's READY conditions key on
 * `main h1` plus `[data-perf-ready]`, and a skeleton that satisfied them would
 * report the skeleton as the content.
 */
export function RouteSkeleton({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const t = useTranslations('common');

  return (
    <div role="status" aria-busy="true" className={cn(className)}>
      <span className="sr-only">{t('loading')}</span>
      {children}
    </div>
  );
}
