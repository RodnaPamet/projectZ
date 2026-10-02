import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/** /platform/moderation: the title, then the queue of reviews to decide. */
export default function Loading() {
  return (
    // Inside the platform shell (T19), which pads the column and owns the page.
    <RouteSkeleton>
      <PageTitleSkeleton />
      <CardListSkeleton rows={3} lines={3} className="gap-4" />
    </RouteSkeleton>
  );
}
