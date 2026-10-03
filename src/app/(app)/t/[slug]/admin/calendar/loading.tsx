import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { PageTitleSkeleton } from '@/components/loading/shapes';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The club diary, inside the club layout's <main> (the header and the club nav
 * stay on screen; only this segment is replaced). NOT shown on a day forward
 * or back: a ?day= change keeps the same segment, so the old day stays up until
 * the new one renders (calendar -> next day measured unchanged at ~213 ms, first
 * feedback via the URL commit, in the PR #289 perf table).
 *
 * In the grid's final shape (T26): the day row (two pill links around the day's
 * heading), the legend's two badges over the hint, then the hour ruler beside
 * court cards, each a header over hour rows. The same gaps, column template
 * and 56 px rows as DayGrid.tsx, so the grid streams in where the bars were.
 * Three courts, not the club's count: the skeleton cannot know it, and three
 * fit a 393 px phone inside the same sideways scroller the real grid uses.
 */
const COURTS = 3;
const HOURS = 8;
const ROW_HEIGHT = 56;

export default function Loading() {
  return (
    <RouteSkeleton>
      <PageTitleSkeleton size="md" />
      <div className="gap-default grid">
        <div className="gap-tight flex flex-wrap items-center">
          <Skeleton className="h-7 w-32 rounded-full pointer-coarse:h-11" />
          <div className="sm:px-tight order-first w-full sm:order-none sm:w-auto">
            <Skeleton className="h-6 w-48" />
          </div>
          <Skeleton className="h-7 w-32 rounded-full pointer-coarse:h-11" />
        </div>

        <div className="gap-tight grid">
          <div className="gap-tight flex">
            <Skeleton className="h-6 w-24 rounded-full" />
            <Skeleton className="h-6 w-40 rounded-full" />
          </div>
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>

        <div className="overflow-x-auto pb-1">
          <div
            className="gap-x-tight grid min-w-max grid-rows-[auto_auto]"
            style={{ gridTemplateColumns: `3.5rem repeat(${COURTS}, minmax(9rem, 1fr))` }}
          >
            <div className="col-start-1 row-start-2">
              {Array.from({ length: HOURS }).map((_, h) => (
                <div key={h} className="flex justify-end pr-1" style={{ height: ROW_HEIGHT }}>
                  <Skeleton className="h-3 w-8" />
                </div>
              ))}
            </div>
            {Array.from({ length: COURTS }).map((_, col) => (
              <div
                key={col}
                className="border-border-subtle row-span-2 row-start-1 grid grid-rows-subgrid rounded-lg border"
                style={{ gridColumnStart: col + 2 }}
              >
                <div className="border-border-subtle px-tight border-b py-2">
                  <Skeleton className="h-5 w-3/4" />
                </div>
                <div>
                  {Array.from({ length: HOURS }).map((__, row) => (
                    <div
                      key={row}
                      className={row > 0 ? 'border-border-subtle border-t px-1' : 'px-1'}
                      style={{ height: ROW_HEIGHT }}
                    >
                      {/* A few "bookings", placed by a fixed pattern so it is stable. */}
                      {(row + col) % 3 === 0 && <Skeleton className="mt-1 h-12 rounded-md" />}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </RouteSkeleton>
  );
}
