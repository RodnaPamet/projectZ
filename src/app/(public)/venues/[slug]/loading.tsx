import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton, SkeletonPill } from '@/components/ui/skeleton';

import { VenueBackLink } from './VenueBackLink';

/**
 * /venues/{slug}: the cover band, the name and address, the day picker, then
 * one card per court (T12). No header stand-in: (public)/layout.tsx renders
 * the real one around this. What a venue card's auto prefetch fetches, so a
 * tap from /venues paints this at once, and the page's JS chunk with it
 * (VenueBackLink, #403).
 */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page">
      <div className="safe-area-x">
        <div className="in-shell:p-0 mx-auto flex w-full max-w-3xl flex-col gap-6 pb-6 md:px-6 md:pt-6">
          <div className="relative">
            <Skeleton className="in-shell:rounded-lg h-32 w-full rounded-none md:h-40 md:rounded-lg" />
            {/* The real back link: usable while the page loads, and the
                client reference that preloads the page's JS chunk (#403,
                see VenueBackLink). */}
            <VenueBackLink />
          </div>
          <div className="in-shell:px-0 flex flex-col gap-2 px-6 md:px-0">
            <PageTitleSkeleton />
            <Skeleton className="h-4 w-2/3" />
            <div className="flex gap-1">
              <SkeletonPill />
              <SkeletonPill />
            </div>
          </div>
          <div className="in-shell:px-0 flex gap-1 px-6 md:px-0">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonPill key={i} />
            ))}
          </div>
          <div className="in-shell:px-0 px-6 md:px-0">
            <CardListSkeleton rows={3} lines={3} />
          </div>
        </div>
      </div>
    </RouteSkeleton>
  );
}
