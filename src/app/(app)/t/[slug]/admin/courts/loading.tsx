import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardGridSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/** Courts: the title, the add button, then the grid of court cards. */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <Skeleton className="mb-4 h-11 w-36 rounded-md" />
      <CardGridSkeleton count={3} className="gap-3" />
    </RouteSkeleton>
  );
}
