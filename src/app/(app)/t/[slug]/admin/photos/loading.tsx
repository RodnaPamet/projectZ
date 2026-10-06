import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { FieldSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Photos and info (#366), in the board's layout: the title and subtitle, then
 * one card per venue with its name, the cover band and its upload row, and the
 * gallery heading over a strip of thumbnails. Same gaps as the board.
 */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <div className="border-border-subtle gap-default grid rounded-lg border p-4">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="aspect-[3/1] w-full rounded-md" />
        <FieldSkeleton />
        <Skeleton className="h-5 w-1/4" />
        <div className="gap-compact grid grid-cols-2 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[4/3] w-full rounded-md" />
          ))}
        </div>
      </div>
    </RouteSkeleton>
  );
}
