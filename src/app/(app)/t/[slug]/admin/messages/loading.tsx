import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/** The club's inbox (#375): the title and its subtitle, then rows of conversations. */
export default function Loading() {
  return (
    <RouteSkeleton>
      <div className="mx-auto w-full max-w-3xl">
        <PageTitleSkeleton size="md" className="mb-6" />
        <CardListSkeleton rows={5} lines={2} className="gap-compact" />
      </div>
    </RouteSkeleton>
  );
}
