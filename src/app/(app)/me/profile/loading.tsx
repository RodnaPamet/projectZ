import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/** The profile page's shape while it loads: the identity line, then two groups of rows. */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page flex-1">
      <div className="gap-section mx-auto flex w-full max-w-2xl flex-col px-4 py-6 md:px-6 md:py-10">
        <PageTitleSkeleton size="md" />
        <CardSkeleton lines={2} />
        <CardSkeleton lines={1} />
      </div>
    </RouteSkeleton>
  );
}
