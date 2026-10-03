import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/** /platform/security: the title, then the two-step verification panel. */
export default function Loading() {
  return (
    // Inside the platform shell (T19), which pads the column and owns the page.
    <RouteSkeleton>
      <PageTitleSkeleton />
      <CardListSkeleton rows={1} lines={3} />
    </RouteSkeleton>
  );
}
