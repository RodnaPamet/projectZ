import { RouteSkeleton } from '@/components/loading/route-skeleton';
import {
  CardGridSkeleton,
  PageTitleSkeleton,
  SiteHeaderSkeleton,
} from '@/components/loading/shapes';

/** /venues: the header, the title and the count, then the venue card grid. */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page">
      <SiteHeaderSkeleton />
      <div className="safe-area-x">
        <div className="px-6 py-10">
          <PageTitleSkeleton className="mb-8" />
          <CardGridSkeleton count={6} />
        </div>
      </div>
    </RouteSkeleton>
  );
}
