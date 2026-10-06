import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * /me/bookings/{id} (#359): shaped like `BookingDetail`, in its wrapper: the
 * back link, the venue title with its court line, a card of four rows (when,
 * court, price, address), the directions button, and the players card.
 */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page safe-area-x flex flex-1 flex-col">
      <div className="gap-section mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-6 md:px-6 md:py-10">
        <Skeleton className="h-5 w-28" />
        <PageTitleSkeleton size="md" />
        <div className="border-border-subtle divide-border-subtle divide-y rounded-lg border">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex min-h-14 items-center justify-between gap-4 px-4 py-3">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-2/5" />
            </div>
          ))}
        </div>
        <Skeleton className="h-10 w-36" />
        <div className="border-border-subtle rounded-lg border">
          <div className="flex min-h-14 items-center gap-3 px-4 py-2">
            <Skeleton className="size-8 rounded-full" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
      </div>
    </RouteSkeleton>
  );
}
