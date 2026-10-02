import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

const ROWS = 6;

/**
 * Players, in the board's final layout (T25): the title and its subtitle, the
 * search field, then the DataTable — a header row over five-column rows from
 * md, and below md the table's cards, one label/value line per column (name,
 * email, tags, credit, no-shows). The same `gap-default` as the board, and the
 * table and the cards swap on the same breakpoint the DataTable does, so
 * nothing jumps when the page streams in.
 */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <div className="gap-default grid">
        <div className="grid gap-1.5 sm:max-w-xs">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9 w-full rounded-md pointer-coarse:h-11" />
        </div>

        <div className="border-border-subtle hidden rounded-lg border md:block">
          <div className="border-border-subtle grid grid-cols-[2fr_2fr_1.5fr_1fr_1fr] gap-4 border-b px-4 py-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-3 w-16" />
            ))}
          </div>
          {Array.from({ length: ROWS }).map((_, i) => (
            <div
              key={i}
              className="border-border-subtle grid grid-cols-[2fr_2fr_1.5fr_1fr_1fr] items-center gap-4 border-b px-4 py-3 last:border-b-0"
            >
              <Skeleton className="h-4 w-3/5" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-5 w-14 rounded-full" />
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-4 w-6" />
            </div>
          ))}
        </div>

        <div className="gap-default flex flex-col md:hidden">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="border-border-subtle gap-tight grid rounded-lg border p-4">
              {['w-2/5', 'w-3/5', 'w-1/4', 'w-1/5', 'w-8'].map((w, j) => (
                <div key={j} className="flex items-center justify-between gap-4">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className={`h-4 ${w}`} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </RouteSkeleton>
  );
}
