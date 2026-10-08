import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The club admin's home (#362), in its layout: the title with the theme row
 * beside it, then a row of buttons under each section's eyebrow. Every admin
 * page below has its own loading.tsx, which is what paints on a tap to it.
 */
export default function Loading() {
  return (
    <RouteSkeleton>
      <div className="gap-default flex flex-wrap items-center justify-between">
        <PageTitleSkeleton size="md" />
        <Skeleton className="h-9 w-40 rounded-lg" />
      </div>
      {[2, 3, 2].map((count, i) => (
        <div key={i} className="space-y-default">
          <Skeleton className="h-3 w-20" />
          <div className="gap-tight flex flex-wrap">
            {Array.from({ length: count }).map((_, j) => (
              <Skeleton key={j} className="h-9 w-28 rounded-lg" />
            ))}
          </div>
        </div>
      ))}
    </RouteSkeleton>
  );
}
