import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/** /platform/moderation: the title, then the queue of reviews to decide. */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page safe-area-top safe-area-x min-h-screen">
      <div className="px-6 py-10">
        <PageTitleSkeleton />
        <CardListSkeleton rows={3} lines={3} className="gap-4" />
      </div>
    </RouteSkeleton>
  );
}
