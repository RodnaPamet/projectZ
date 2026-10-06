import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/** /start/kind: the question, two answers, Продължи (#360). */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page safe-area-x flex-1">
      <div className="mx-auto max-w-md px-4 py-10 md:px-6 md:py-16">
        <Skeleton className="h-8 w-56 max-w-full" />
        <Skeleton className="mt-3 h-4 w-full" />
        <Skeleton className="mt-6 h-20 w-full rounded-lg" />
        <Skeleton className="mt-3 h-20 w-full rounded-lg" />
        <Skeleton className="mt-6 h-11 w-full rounded-md" />
      </div>
    </RouteSkeleton>
  );
}
