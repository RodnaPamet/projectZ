import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/** /t/{slug}/admin/coaches: the title, then the requests and the coaches. */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton />
      <CardListSkeleton rows={3} lines={3} className="gap-4" />
    </RouteSkeleton>
  );
}
