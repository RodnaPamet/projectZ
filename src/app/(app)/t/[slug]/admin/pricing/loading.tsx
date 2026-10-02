import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Pricing, in the board's final layout (T24): the title and its subtitle, then
 * — beside each other from lg — the court picker with its base price over the
 * rule cards and the add button, and the price-check card. Each rule card is
 * a priority and name over its conditions with the effect and trace badge
 * beside them, then Edit and Delete. Same gaps as the board (`gap-section`
 * between the columns, `gap-default` down the left one, `gap-tight` between
 * the cards), so nothing jumps when the page streams in.
 */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <div className="gap-section grid lg:grid-cols-[2fr_1fr]">
        <div className="gap-default grid content-start">
          <div className="gap-tight grid sm:max-w-xs">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-9 w-full rounded-md pointer-coarse:h-11" />
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="gap-tight grid">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="border-border-subtle rounded-lg border p-4">
                <div className="gap-compact flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <Skeleton className="h-5 w-2/5" />
                    <Skeleton className="mt-1 h-4 w-3/5" />
                  </div>
                  <div className="gap-tight flex shrink-0 items-center">
                    <Skeleton className="h-5 w-12" />
                    <Skeleton className="h-5 w-20 rounded-full" />
                  </div>
                </div>
                <div className="mt-compact gap-tight flex">
                  <Skeleton className="h-7 w-24 rounded-md pointer-coarse:h-11" />
                  <Skeleton className="h-7 w-24 rounded-md pointer-coarse:h-11" />
                </div>
              </div>
            ))}
          </div>
          <Skeleton className="h-7 w-32 rounded-md pointer-coarse:h-11" />
        </div>
        <div className="border-border-subtle h-fit rounded-lg border p-4">
          <Skeleton className="mb-compact h-5 w-32" />
          <div className="gap-compact grid">
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-9 w-full rounded-md pointer-coarse:h-11" />
            <div className="gap-compact grid grid-cols-2">
              <Skeleton className="h-9 w-full rounded-md pointer-coarse:h-11" />
              <Skeleton className="h-9 w-full rounded-md pointer-coarse:h-11" />
            </div>
          </div>
          <div className="border-border-subtle mt-default pt-default grid gap-1 border-t">
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-40" />
          </div>
        </div>
      </div>
    </RouteSkeleton>
  );
}
