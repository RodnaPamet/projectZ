import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/** /platform/coaches: the title, then the profiles to decide. */
export default function Loading() {
  return (
    // Inside the platform shell (T19), which pads the column and owns the page.
    <RouteSkeleton>
      <PageTitleSkeleton />
      <CardListSkeleton rows={3} lines={4} className="gap-4" />
    </RouteSkeleton>
  );
}
