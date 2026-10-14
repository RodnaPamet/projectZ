import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/** /coaches: the title, then the cards. */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page safe-area-x">
      <div className="in-shell:p-0 mx-auto w-full max-w-3xl px-6 py-10">
        <PageTitleSkeleton />
        <CardListSkeleton rows={4} lines={2} className="mt-6 gap-3" />
      </div>
    </RouteSkeleton>
  );
}
