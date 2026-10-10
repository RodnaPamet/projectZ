import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardListSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * /messages (#375): the title, the Разговори / «Заявки» toggle, then rows of
 * conversations, as the page lays them out. Shown only while the server reads
 * the open tab's first page; the list itself paints from that seed.
 */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page safe-area-x flex-1">
      <div className="in-shell:p-0 mx-auto w-full max-w-2xl px-4 py-6 md:px-6 md:py-10">
        <PageTitleSkeleton size="md" subtitle={false} className="mb-section" />
        <Skeleton className="mb-section h-12 w-56 rounded-lg" />
        <CardListSkeleton rows={5} lines={2} className="gap-compact" />
      </div>
    </RouteSkeleton>
  );
}
