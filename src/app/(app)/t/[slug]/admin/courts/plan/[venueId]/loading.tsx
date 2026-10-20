import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * A venue's plan editor (#626), in its final layout: the title and subtitle,
 * the hint, the canvas at its own height, and the court list, so nothing
 * jumps when the page streams in.
 */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <div className="flex flex-col gap-4">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-[360px] w-full rounded-lg md:h-[480px]" />
        <div className="border-border-subtle divide-border-subtle divide-y rounded-lg border">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-2">
              <div className="flex flex-col gap-1">
                <Skeleton className="h-7 w-24 rounded-md" />
                <Skeleton className="h-4 w-20" />
              </div>
              <Skeleton className="h-7 w-24 rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </RouteSkeleton>
  );
}
