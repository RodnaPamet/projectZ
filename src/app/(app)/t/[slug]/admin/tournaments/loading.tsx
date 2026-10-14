import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/** «Турнири» in its final layout (#579): the title, the button, the cards. */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <div className="gap-section grid">
        <Skeleton className="h-9 w-36 rounded-md" />
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="border-border-subtle grid gap-3 rounded-lg border p-4">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-64 max-w-full" />
            </div>
          ))}
        </div>
      </div>
    </RouteSkeleton>
  );
}
