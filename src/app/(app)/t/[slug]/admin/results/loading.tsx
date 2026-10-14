import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * «Резултати» in its final layout (#575): the title and subtitle, then the two
 * lists, each a heading over cards of a result. Same gaps as the page.
 */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <div className="gap-section grid">
        {Array.from({ length: 2 }).map((_, list) => (
          <div key={list} className="gap-compact grid">
            <Skeleton className="h-5 w-40" />
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="border-border-subtle grid gap-3 rounded-lg border p-4">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-10 w-full" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </RouteSkeleton>
  );
}
