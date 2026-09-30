import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { SiteHeaderSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The home page's shape: the header, then the wordmark, the tagline and the
 * call to action, centred as page.tsx centres them.
 *
 * Being at the root, this is also the fallback for any route with no
 * loading.tsx of its own. tests/guardrails/route-loading-coverage.test.ts
 * keeps that list to the ones with a stated reason.
 */
export default function Loading() {
  return (
    <RouteSkeleton>
      <SiteHeaderSkeleton />
      <div className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center gap-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-10 w-32 rounded-md" />
      </div>
    </RouteSkeleton>
  );
}
