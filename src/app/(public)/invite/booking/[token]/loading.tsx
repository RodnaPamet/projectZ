import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/** /invite/booking/[token]: the game, then the join button (#358). */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page safe-area-x flex-1">
      <div className="in-shell:p-0 mx-auto max-w-md px-4 py-10 md:px-6 md:py-16">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="mt-6 h-40 w-full rounded-lg" />
        <Skeleton className="mt-6 h-11 w-40 rounded-md" />
      </div>
    </RouteSkeleton>
  );
}
