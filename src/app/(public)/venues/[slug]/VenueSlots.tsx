import { CardListSkeleton } from '@/components/loading/shapes';
import { RouteSkeleton } from '@/components/loading/route-skeleton';
import { Skeleton, SkeletonPill } from '@/components/ui/skeleton';
import { loadVenueAvailability } from '@/app-layer/usecases/venue-availability';
import { toAvailability } from '@/app/api/v1/_lib/dto';
import { resolveAvailabilityRange } from '@/app/api/v1/_lib/range';
import { playerChrome } from '@/components/layout/SiteHeader';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { ViewerScope } from '@/lib/data/provider';
import { countPageUsage } from '@/lib/usage/record';

import { bookingDays, parseInitialPick } from './booking-days';
import { VenueBooking } from './VenueBooking';

/**
 * The venue page's second stage (#403): the day picker and the first day's
 * slots, server-rendered behind their own Suspense boundary in page.tsx, so
 * the header above them never waits for them.
 *
 * The first day's slots are computed here by `loadVenueAvailability` — the
 * loop `GET /api/v1/venues/{id}/availability` runs — and mapped by the same
 * `toAvailability`, for the window `?date=` resolves to. `VenueBooking` holds
 * them under that endpoint's SWR key and revalidates after paint, so a page
 * served from the router cache (up to 30 s old) is corrected on arrival; the
 * other 13 days are read through the same endpoint when picked.
 *
 * "The first day" is today at the club, or the `?day=` a sign-in round trip
 * came back with — so the visitor lands on the slot they picked, rendered.
 */
export async function VenueSlots({
  venue,
  clubSlug,
  searchParams,
}: {
  venue: {
    id: string;
    name: string;
    publicSlug: string;
    timezone: string;
    cancellationCutoffHours: number;
  };
  clubSlug: string;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const now = new Date();
  const days = bookingDays(now, venue.timezone);
  const pick = parseInitialPick(sp, days);

  // The window `GET …/availability?date=` answers, resolved by the same
  // function, so the seed is exactly what the SWR key below would fetch.
  const { from, to } = resolveAvailabilityRange(
    new URLSearchParams({ date: pick.day }),
    venue.timezone,
    now,
  );
  const publicVenue = { id: venue.id, name: venue.name, timezone: venue.timezone };

  // BYPASSRLS for the same reason as the page's venue read (page.tsx).
  const [resources, { me, kind }] = await Promise.all([
    runAsSuperuser((db) => loadVenueAvailability(db, { venue: publicVenue, from, to })),
    playerChrome(),
  ]);
  const seed = toAvailability({ venue: publicVenue, from, to, resources });

  // A player back from sign-in with `?confirm=1` lands on the confirm sheet
  // already open (VenueBooking), so the funnel's "sheet opened" (#371) is
  // counted here, on the server, rather than by the island's beacon.
  if (pick.confirm && kind === 'player') {
    await countPageUsage('SHEET_OPENED', { venueId: venue.id });
  }

  const booking = (
    <VenueBooking
      venue={{ ...venue, clubSlug }}
      days={days}
      seed={{ day: pick.day, availability: seed }}
      initialPick={pick}
      renderedAt={now.toISOString()}
      viewer={kind === 'signed-out' ? 'signed-out' : kind}
    />
  );

  // ViewerScope sends the signed-in user's id with the booking, so a tab left
  // open across a switch to another account is refused 409 VIEWER_CHANGED
  // rather than booking as that account (#263).
  return me ? <ViewerScope viewerId={me.userId}>{booking}</ViewerScope> : booking;
}

/**
 * What stands in for VenueSlots while the day is computed: the section title,
 * the day picker and one card per court, the shapes VenueBooking paints. A
 * status region like every route skeleton, so a screen reader hears that the
 * times are loading, and no `data-perf-ready`: the perf harness would time it
 * as the slots.
 */
export function VenueSlotsSkeleton() {
  return (
    <RouteSkeleton className="flex flex-col gap-4">
      <div className="px-6 md:px-0">
        <Skeleton className="h-6 w-40" />
      </div>
      <div className="flex gap-1 px-6 md:px-0">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonPill key={i} />
        ))}
      </div>
      <div className="px-6 md:px-0">
        <CardListSkeleton rows={3} lines={3} />
      </div>
    </RouteSkeleton>
  );
}
