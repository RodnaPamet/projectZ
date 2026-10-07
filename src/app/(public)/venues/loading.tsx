import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { CardGridSkeleton, PageTitleSkeleton } from '@/components/loading/shapes';

/**
 * /venues: the title and the count, then the venue card grid. No header
 * stand-in since T20: (public)/layout.tsx renders the real one around this.
 */
export default function Loading() {
  return (
    <RouteSkeleton className="bg-bg-page">
      <div className="safe-area-x">
        <div className="in-shell:p-0 px-6 py-10">
          <PageTitleSkeleton className="mb-8" />
          <CardGridSkeleton count={6} />
        </div>
      </div>
    </RouteSkeleton>
  );
}
