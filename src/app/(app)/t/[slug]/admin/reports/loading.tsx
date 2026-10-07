import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * "Отчети и такса" in its final layout (#372): the title and subtitle, the
 * month picker, the totals heading with the CSV button beside it, the four
 * totals (two columns on a phone, four from lg), the terms line, the online
 * share card (#371), and the line items. Same gaps as the page, so nothing jumps when it streams in.
 */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <div className="gap-section grid">
        <div className="grid gap-1.5 sm:max-w-xs">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-9 w-full rounded-md pointer-coarse:h-11" />
        </div>
        <div className="gap-compact grid">
          <div className="gap-compact flex flex-wrap items-center justify-between">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-9 w-32 rounded-md pointer-coarse:h-11" />
          </div>
          <div className="gap-compact grid grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="border-border-subtle rounded-lg border p-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="mt-2 h-8 w-20" />
              </div>
            ))}
          </div>
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
        {/* "Онлайн резервации" (#371): the title, the share, six bars. */}
        <div className="border-border-subtle grid gap-4 rounded-lg border p-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-10 w-24" />
          <Skeleton className="h-16 w-full" />
        </div>
        <div className="gap-compact grid">
          <Skeleton className="h-6 w-32" />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </RouteSkeleton>
  );
}
