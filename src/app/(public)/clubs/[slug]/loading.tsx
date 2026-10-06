import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardGridSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton, SkeletonPill } from '@/components/ui/skeleton';

/**
 * /clubs/{slug} (#356): the cover band, the name, the address and phone, the
 * sports, then the venue cards (T12). No header stand-in: (public)/layout.tsx
 * renders the real one around this. What the club account's "Публична
 * страница" link's auto prefetch fetches, so a tap paints this at once.
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
            <Skeleton className="h-4 w-1/3" />
            <div className="flex gap-1">
              <SkeletonPill />
              <SkeletonPill />
            </div>
          </div>
          <div className="flex flex-col gap-3 px-6 md:px-0">
            <Skeleton className="h-6 w-24" />
            <CardGridSkeleton count={2} className="lg:grid-cols-2" />
          </div>
        </div>
      </div>
    </RouteSkeleton>
  );
}
