import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/** /platform/usage: the title, then the reason form and the two tables' place. */
export default function Loading() {
  return (
    // Inside the platform shell (T19), which pads the column and owns the page.
    <RouteSkeleton>
      <PageTitleSkeleton />
      <CardListSkeleton rows={2} lines={3} />
    </RouteSkeleton>
  );
}
