import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

const ROWS = 4;

/**
 * Staff, in the board's final layout (T25): the title and its subtitle; the
 * invites heading with its button over one invite card; then the members
 * heading over the DataTable — a header row over name, email, role and status
 * from md, and below md the table's cards. The same `gap-section` and
 * `gap-compact` as the board, and the table and the cards swap on the
 * DataTable's own breakpoint, so nothing jumps when the page streams in.
 */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <div className="gap-section grid">
        <div className="gap-compact grid">
          <div className="gap-compact flex items-center">
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-7 w-28 rounded-md pointer-coarse:h-11" />
          </div>
          <div className="border-border-subtle gap-compact flex items-center justify-between rounded-lg border p-4">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-5 w-2/5" />
              <Skeleton className="mt-1 h-4 w-1/3" />
            </div>
            <Skeleton className="h-7 w-24 rounded-md pointer-coarse:h-11" />
          </div>
        </div>

        <div className="gap-compact grid">
          <Skeleton className="h-6 w-24" />

          <div className="border-border-subtle hidden rounded-lg border md:block">
            <div className="border-border-subtle grid grid-cols-[2fr_2fr_1fr_1fr] gap-4 border-b px-4 py-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-3 w-16" />
              ))}
            </div>
            {Array.from({ length: ROWS }).map((_, i) => (
              <div
                key={i}
                className="border-border-subtle grid grid-cols-[2fr_2fr_1fr_1fr] items-center gap-4 border-b px-4 py-3 last:border-b-0"
              >
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            ))}
          </div>

          <div className="gap-default flex flex-col md:hidden">
            {Array.from({ length: ROWS }).map((_, i) => (
              <div key={i} className="border-border-subtle gap-tight grid rounded-lg border p-4">
                {['w-2/5', 'w-3/5', 'w-20', 'w-16'].map((w, j) => (
                  <div key={j} className="flex items-center justify-between gap-4">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className={`h-4 ${w}`} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </RouteSkeleton>
  );
}
