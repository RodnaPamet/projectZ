import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * /me/bookings: the title, then a list of booking cards, in the page's own
 * wrapper. No header stand-in since T20: (app)/me/layout.tsx renders the real
 * one around this.
 *
 * Shaped like the page as T22 left it: a `Heading level={1}` (text-2xl, so the
 * `md` title bar, not the 3xl `lg`) with `mb-section` under it, and cards of
 * three lines — venue and court, the time, the price — `gap-compact` apart.
 * This shows only on a navigation that has to wait for the server's seed; the
 * list itself never shows a skeleton, because it paints from that seed.
 */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page safe-area-x flex-1">
      <div className="px-6 py-10">
        <PageTitleSkeleton size="md" subtitle={false} className="mb-section" />
        {/* The Предстоящи / Минали toggle (#359): two 44 px options. */}
        <Skeleton className="mb-section h-12 w-52 rounded-lg" />
        <CardListSkeleton rows={4} lines={3} className="gap-compact" />
      </div>
    </RouteSkeleton>
  );
}
