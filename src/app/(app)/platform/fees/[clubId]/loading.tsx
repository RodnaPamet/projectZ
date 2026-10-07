import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/** One club's statement from the platform (#372): the title, the back link, the statement. */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton />
      <div className="gap-section grid">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-64 max-w-full" />
        <div className="gap-compact grid grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="border-border-subtle rounded-lg border p-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-2 h-8 w-20" />
            </div>
          ))}
        </div>
        <div className="gap-compact grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </RouteSkeleton>
  );
}
