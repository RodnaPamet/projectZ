import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/** /platform/fees: the title, the reason form and the month picker (#372). */
export default function Loading() {
  return (
    // Inside the platform shell (T19), which pads the column and owns the page.
    <RouteSkeleton>
      <PageTitleSkeleton />
      <div className="gap-section grid">
        <div className="border-border-subtle grid gap-3 rounded-lg border p-4 sm:max-w-xl">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9 w-full rounded-md pointer-coarse:h-11" />
          <Skeleton className="h-9 w-28 rounded-md pointer-coarse:h-11" />
        </div>
        <div className="grid gap-1.5 sm:max-w-xs">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-9 w-full rounded-md pointer-coarse:h-11" />
        </div>
      </div>
    </RouteSkeleton>
  );
}
