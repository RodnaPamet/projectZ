import { RouteSkeleton } from '@/components/loading/route-skeleton';
import {
  CardListSkeleton,
  PageTitleSkeleton,
  SiteHeaderSkeleton,
} from '@/components/loading/shapes';

/** /me/bookings: the header, the title, then a list of booking cards. */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page safe-area-top safe-area-x min-h-screen">
      <SiteHeaderSkeleton />
      <div className="px-6 py-10">
        <PageTitleSkeleton subtitle={false} className="mb-8" />
        <CardListSkeleton rows={4} lines={3} />
      </div>
    </RouteSkeleton>
  );
}
