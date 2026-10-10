import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * One conversation (#375): the way back, who it is with, a few messages on
 * alternating sides, and the composer at the foot.
 */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page safe-area-x flex flex-1 flex-col">
      <div className="in-shell:p-0 mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 px-4 py-4 md:px-6 md:py-8">
        <Skeleton className="h-5 w-28" />
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-full" />
          <Skeleton className="h-6 w-40" />
        </div>
        <div className="flex flex-1 flex-col gap-3">
          <Skeleton className="h-12 w-2/3 self-start rounded-lg" />
          <Skeleton className="h-12 w-1/2 self-end rounded-lg" />
          <Skeleton className="h-16 w-3/5 self-start rounded-lg" />
        </div>
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
    </RouteSkeleton>
  );
}
