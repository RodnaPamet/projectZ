import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/** One of the club's tournaments (#579): the title, the actions, the entries. */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <div className="gap-section grid">
        <div className="flex gap-2">
          <Skeleton className="h-9 w-40 rounded-md" />
          <Skeleton className="h-9 w-24 rounded-md" />
        </div>
        <div className="border-border-subtle grid gap-3 rounded-lg border p-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      </div>
    </RouteSkeleton>
  );
}
