import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardGridSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/** Игри's first paint (#376): the title, then the games' cards. */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page">
      <div className="safe-area-x">
        <div className="in-shell:p-0 px-6 py-10">
          <PageTitleSkeleton className="mb-8" />
          <CardGridSkeleton count={4} />
        </div>
      </div>
    </RouteSkeleton>
  );
}
