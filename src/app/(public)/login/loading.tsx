import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * /login: the title and subtitle, then a column of full-width sign-in
 * buttons, in the same narrow centred column as page.tsx.
 */
export default function Loading() {
  return (
    <RouteSkeleton className="in-shell:px-0 mx-auto flex min-h-[70vh] w-full max-w-sm flex-col justify-center px-4">
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-56" />
        </div>
        <div className="space-y-3">
          <Skeleton className="h-11 w-full rounded-md" />
          <Skeleton className="h-11 w-full rounded-md" />
          <Skeleton className="h-11 w-full rounded-md" />
        </div>
      </div>
    </RouteSkeleton>
  );
}
