import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/** /invite/[token]: the club's invitation, then the accept button. */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page safe-area-top safe-area-x min-h-screen">
      <div className="mx-auto max-w-md px-6 py-16">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="mt-3 h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-48" />
        <Skeleton className="mt-6 h-10 w-36 rounded-md" />
      </div>
    </RouteSkeleton>
  );
}
