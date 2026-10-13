import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/** The coach profile's shape while it loads: the title, where it stands, then three sections. */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page flex-1">
      <div className="gap-section in-shell:p-0 mx-auto flex w-full max-w-2xl flex-col px-4 py-6 md:px-6 md:py-10">
        <PageTitleSkeleton size="md" />
        <CardSkeleton lines={1} />
        <CardSkeleton lines={4} />
        <CardSkeleton lines={3} />
        <CardSkeleton lines={2} />
      </div>
    </RouteSkeleton>
  );
}
