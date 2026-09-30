import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { SiteHeaderSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The home page's shape: the header, then the wordmark, the tagline and the
 * call to action, centred as page.tsx centres them.
 *
 * In the `(home)` route group, NOT at src/app/loading.tsx. A root loading.tsx
 * would wrap every layout too, and every redirect and 404 under it would
 * stream as a 200 (see tests/guardrails/route-loading-coverage.test.ts).
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
