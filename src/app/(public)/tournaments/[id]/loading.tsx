import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/** A tournament's page (#579): the title, the facts, the entry card. */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <div className="gap-section grid max-w-2xl">
        <div className="border-border-subtle grid gap-3 rounded-lg border p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
        <div className="border-border-subtle grid gap-3 rounded-lg border p-4">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-9 w-32 rounded-md" />
        </div>
      </div>
    </RouteSkeleton>
  );
}
