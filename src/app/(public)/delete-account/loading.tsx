import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * /delete-account: the title and its lead, then the sections of help text,
 * in the same readable column as page.tsx.
 */
export default function Loading() {
  return (
    <RouteSkeleton className="in-shell:p-0 gap-section mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-8 md:px-6 md:py-12">
      <div className="space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ))}
    </RouteSkeleton>
  );
}
