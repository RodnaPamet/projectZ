import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/** The diary's weekly series (#415): the title and a list of cards. */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton />
      <CardListSkeleton rows={3} lines={2} />
    </RouteSkeleton>
  );
}
