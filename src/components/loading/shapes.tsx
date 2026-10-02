import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';

/**
 * The page shapes the route skeletons are built from.
 *
 * Each mirrors the markup of the page it stands in for — the same padding,
 * the same card border and radius, the same grid breakpoints — so that when
 * the content streams in it lands where the bars were, instead of the page
 * jumping. The class lists are copied from the pages on purpose, and a page
 * that changes its shape should change its skeleton in the same PR.
 *
 * Every bar is a design-system `Skeleton`, which is `aria-hidden`; the
 * accessible part (role, busy state, label) is `RouteSkeleton`'s alone.
 */

/**
 * Where `SiteHeader` will be, on the home page only since T20: /venues and
 * /me/bookings get the real header from their layouts, around their loading
 * state, but `/` renders its chrome INSIDE the page, so its loading state
 * replaces the header too; without a stand-in the skeleton would jump up by
 * a row and back down when the page arrives.
 *
 * A `div`, not a `header`: it holds no links, and the perf harness clicks
 * `header a[href=…]`, which must only ever find the real one.
 */
export function SiteHeaderSkeleton() {
  return (
    <div className="border-border-subtle flex min-h-16 items-center justify-between gap-x-4 border-b px-4">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-9 w-20 rounded-md" />
    </div>
  );
}

/**
 * The h1 and the line under it. `size` follows the page: the player pages use
 * text-3xl headings, the club admin pages text-2xl.
 */
export function PageTitleSkeleton({
  size = 'lg',
  subtitle = true,
  className,
}: {
  size?: 'lg' | 'md';
  subtitle?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('mb-6', className)}>
      <Skeleton className={size === 'lg' ? 'h-9 w-56' : 'h-8 w-44'} />
      {subtitle && <Skeleton className="mt-2 h-4 w-72 max-w-full" />}
    </div>
  );
}

/** One bordered card: a title line, then `lines` shorter ones. */
export function CardSkeleton({ lines = 2, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('border-border-subtle rounded-lg border p-4', className)}>
      <Skeleton className="h-5 w-2/5" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn('mt-2 h-4', i === lines - 1 ? 'w-1/3' : 'w-3/4')} />
      ))}
    </div>
  );
}

/** A vertical list of cards: my bookings, players, staff, the moderation queue. */
export function CardListSkeleton({
  rows = 4,
  lines = 2,
  className,
}: {
  rows?: number;
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-3', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <CardSkeleton key={i} lines={lines} />
      ))}
    </div>
  );
}

/** The responsive card grid of /venues and the courts board. */
export function CardGridSkeleton({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('grid gap-4 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <CardSkeleton key={i} lines={3} />
      ))}
    </div>
  );
}

/** A search or select field above a list, as on the players and pricing boards. */
export function FieldSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('mb-4 grid gap-1.5 sm:max-w-xs', className)}>
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-10 w-full rounded-md" />
    </div>
  );
}

/**
 * The diary: day navigation, then an hour column beside three court columns.
 * Three, not the club's count: the skeleton cannot know it, and three fits a
 * 393 px phone without the sideways scroll the real grid needs for more.
 */
export function DiarySkeleton() {
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Skeleton className="h-9 w-24 rounded-md" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-9 w-24 rounded-md" />
      </div>
      <Skeleton className="h-4 w-64 max-w-full" />
      <div className="mt-4 grid grid-cols-[3rem_repeat(3,minmax(0,1fr))] gap-2">
        <div />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-5 w-3/4" />
        ))}
        {Array.from({ length: 8 }).map((_, row) => (
          <DiaryRow key={row} row={row} />
        ))}
      </div>
    </>
  );
}

function DiaryRow({ row }: { row: number }) {
  return (
    <>
      <Skeleton className="h-3 w-8" />
      {Array.from({ length: 3 }).map((_, col) => (
        <div key={col} className="border-border-subtle h-12 border-t">
          {/* A few "bookings", placed by a fixed pattern so it is stable. */}
          {(row + col) % 3 === 0 && <Skeleton className="mt-1 h-10 rounded-md" />}
        </div>
      ))}
    </>
  );
}
