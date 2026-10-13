import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/** /platform/clubs: the title and the reason form (#254). */
export default function Loading() {
  return (
    // Inside the platform shell (T19), which pads the column and owns the page.
    <RouteSkeleton>
      <PageTitleSkeleton />
      <div className="border-border-subtle grid gap-3 rounded-lg border p-4 sm:max-w-xl">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-9 w-full rounded-md pointer-coarse:h-11" />
        <Skeleton className="h-9 w-28 rounded-md pointer-coarse:h-11" />
      </div>
    </RouteSkeleton>
  );
}
