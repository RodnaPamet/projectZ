import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Courts, in the board's final layout (T23): the title and its subtitle, the
 * add button, then the card grid — each card a name over its venue with the
 * status badge beside it, three setting/capacity/price rows, and the Edit and
 * Archive buttons. Same gaps as the board (`gap-default` under the button,
 * `gap-compact` between cards), so nothing jumps when the page streams in.
 */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <div className="gap-default grid">
        <Skeleton className="h-11 w-36 rounded-md" />
        <div className="gap-compact grid sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="border-border-subtle rounded-lg border p-4">
              <div className="gap-compact flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-5 w-2/5" />
                  <Skeleton className="mt-1 h-4 w-1/2" />
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <div className="mt-compact grid grid-cols-2 gap-x-4 gap-y-1">
                {Array.from({ length: 6 }).map((__, j) => (
                  <Skeleton key={j} className="h-4 w-3/4" />
                ))}
              </div>
              <div className="mt-compact gap-tight flex">
                <Skeleton className="h-11 w-24 rounded-md" />
                <Skeleton className="h-11 w-28 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </RouteSkeleton>
  );
}
