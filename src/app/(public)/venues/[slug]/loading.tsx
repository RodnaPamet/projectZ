import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton, SkeletonPill } from '@/components/ui/skeleton';

/**
 * /venues/{slug}: the cover band, the name and address, the day picker, then
 * one card per court (T12). No header stand-in: (public)/layout.tsx renders
 * the real one around this. What a venue card's auto prefetch fetches, so a
 * tap from /venues paints this at once.
 */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page">
      <div className="safe-area-x">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-6 md:px-6 md:pt-6">
          <Skeleton className="h-32 w-full rounded-none md:h-40 md:rounded-lg" />
          <div className="flex flex-col gap-2 px-6 md:px-0">
            <PageTitleSkeleton />
            <Skeleton className="h-4 w-2/3" />
            <div className="flex gap-1">
              <SkeletonPill />
              <SkeletonPill />
            </div>
          </div>
          <div className="flex gap-1 px-6 md:px-0">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonPill key={i} />
            ))}
          </div>
          <div className="px-6 md:px-0">
            <CardListSkeleton rows={3} lines={3} />
          </div>
        </div>
      </div>
    </RouteSkeleton>
  );
}
