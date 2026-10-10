import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { FieldSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/** "Ново съобщение" (#375): the way back, the title and the name field. */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page safe-area-x flex-1">
      <div className="gap-section in-shell:p-0 mx-auto flex w-full max-w-2xl flex-col px-4 py-6 md:px-6 md:py-10">
        <Skeleton className="h-5 w-28" />
        <PageTitleSkeleton size="md" subtitle={false} />
        <FieldSkeleton />
      </div>
    </RouteSkeleton>
  );
}
