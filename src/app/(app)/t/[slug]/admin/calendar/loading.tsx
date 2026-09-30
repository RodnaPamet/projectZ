import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { DiarySkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/**
 * The club diary, inside the club layout's <main> (the header and the club nav
 * stay on screen; only this segment is replaced). NOT shown on a day forward
 * or back: a ?day= change keeps the same segment, so the old day stays up until
 * the new one renders (calendar -> next day measured unchanged at ~213 ms, first
 * feedback via the URL commit, in the PR #289 perf table).
 */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <DiarySkeleton />
    </RouteSkeleton>
  );
}
