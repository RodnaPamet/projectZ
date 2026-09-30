import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { DiarySkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/**
 * The club diary, inside the club layout's <main> (the header and the club nav
 * stay on screen; only this segment is replaced). Also what a day forward or
 * back shows while the other day loads.
 */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <DiarySkeleton />
    </RouteSkeleton>
  );
}
