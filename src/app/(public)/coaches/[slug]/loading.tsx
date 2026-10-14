import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/** /coaches/{slug}: the coach's name, what they teach, where. */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page safe-area-x flex-1">
      <div className="in-shell:p-0 mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10">
        <PageTitleSkeleton size="md" />
        <CardSkeleton lines={2} />
        <CardSkeleton lines={3} />
        <CardSkeleton lines={2} />
      </div>
    </RouteSkeleton>
  );
}
