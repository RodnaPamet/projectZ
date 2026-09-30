import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, CardSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/** Staff: the invite section, then the members list. */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <CardSkeleton lines={2} />
      <Skeleton className="mt-8 mb-2 h-5 w-32" />
      <CardListSkeleton rows={3} lines={2} className="gap-2" />
    </RouteSkeleton>
  );
}
