import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/** «Създай игра»'s first paint (#697): the title, then the steps. */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page">
      <div className="safe-area-x">
        <div className="in-shell:p-0 px-6 py-10">
          <PageTitleSkeleton className="mb-8" />
          <CardListSkeleton rows={3} />
        </div>
      </div>
    </RouteSkeleton>
  );
}
