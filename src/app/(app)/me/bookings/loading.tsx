import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/**
 * /me/bookings: the title, then a list of booking cards, in the page's own
 * wrapper. No header stand-in since T20: (app)/me/layout.tsx renders the real
 * one around this.
 */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page safe-area-x flex-1">
      <div className="px-6 py-10">
        <PageTitleSkeleton subtitle={false} className="mb-8" />
        <CardListSkeleton rows={4} lines={3} />
      </div>
    </RouteSkeleton>
  );
}
