import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, FieldSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/** Players: the title, the search field, then the list of players. */
export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <FieldSkeleton />
      <CardListSkeleton rows={5} lines={2} className="gap-2" />
    </RouteSkeleton>
  );
}
