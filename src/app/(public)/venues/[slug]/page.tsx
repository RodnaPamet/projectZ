import { cache } from 'react';

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getVenueByPublicSlug } from '@/app-layer/repositories/venue';
import { loadVenueAvailability } from '@/app-layer/usecases/venue-availability';
import { toAvailability } from '@/app/api/v1/_lib/dto';
import { resolveAvailabilityRange } from '@/app/api/v1/_lib/range';
import { playerChrome } from '@/components/layout/SiteHeader';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { ViewerScope } from '@/lib/data/provider';

import { bookingDays, isPublicSlug, parseInitialPick } from './booking-days';
import { VenueBooking } from './VenueBooking';
import { VenueHeader } from './VenueHeader';

/**
 * The venue page, `/venues/{publicSlug}` (#355, audit A01): who the venue is,
 * then a day picker and every court's free times, and "Резервирай".
 *
 * ═══ ADDRESSED BY `publicSlug`, NOT `slug` OR `id` ═══
 *
 * `venue.slug` is unique only within its club, so `/venues/central-courts`
 * could name two venues. `publicSlug` (P40) is unique everywhere and readable,
 * which is what a URL people share and search engines index wants. The v1 API
 * keeps addressing venues by id; this page reads them by `publicSlug` itself.
 *
 * ═══ THE HEADER AND THE FIRST DAY ARE SERVER-RENDERED ═══
 *
 * The first day's slots are computed here by `loadVenueAvailability` — the
 * loop `GET /api/v1/venues/{id}/availability` runs — and mapped by the same
 * `toAvailability`, for the window `?date=` resolves to. `VenueBooking` holds
 * them under that endpoint's SWR key and revalidates after paint, so a page
 * served from the router cache (up to 30 s old) is corrected on arrival; the
 * other 13 days are read through the same endpoint when picked. `loading.tsx`
 * paints the skeleton meanwhile (T12).
 *
 * "The first day" is today at the club, or the `?day=` a sign-in round trip
 * came back with — so the visitor lands on the slot they picked, rendered.
 *
 * ═══ SIGNED OUT SEES EVERYTHING ═══
 *
 * Nothing on the page needs a session except the booking itself. A signed-out
 * "Резервирай" goes to /login with `next` pointing back here at the picked
 * slot (see VenueBooking for how that URL is built and why it is safe).
 */

/** One venue, read once per request by the metadata and the page alike. */
const readVenue = cache(async (publicSlug: string) => {
  if (!isPublicSlug(publicSlug)) return null;

  // BYPASSRLS, as the venue index and the public v1 venue routes: a public
  // page has no tenant to bind, and `venue` carries FORCE row security, so as
  // app_user this would find nothing. `status: ACTIVE` in the repository and
  // the fields picked below are what keep it public-safe. The club's slug
  // (what `POST /t/{slug}/bookings` takes) shares the transaction:
  // `venue.tenantId` is not a foreign key, so a venue whose club is gone is a
  // 404 here as it is on the API.
  return runAsSuperuser(async (db) => {
    const venue = await getVenueByPublicSlug(db, publicSlug);
    if (!venue) return null;
    const club = await db.venueOrg.findUnique({
      where: { id: venue.tenantId },
      select: { slug: true, status: true },
    });
    if (!club || club.status !== 'ACTIVE') return null;
    return { venue, clubSlug: club.slug };
  });
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const found = await readVenue(slug);
  // The page answers 404 (notFound below); its not-found page names itself.
  if (!found) return { robots: { index: false } };
  const t = await getTranslations('venue');

  const { venue } = found;
  const title = t('metaTitle', { name: venue.name });
  const description = t('metaDescription', {
    name: venue.name,
    address: venue.addressLine,
    city: venue.city,
  });
  const path = `/venues/${venue.publicSlug}`;

  return {
    // NEXTAUTH_URL is the app's own origin (the login page builds callbacks
    // from it too), so the canonical URL names the host the page is served on.
    ...(process.env.NEXTAUTH_URL ? { metadataBase: new URL(process.env.NEXTAUTH_URL) } : {}),
    title,
    description,
    // One canonical address: `?day=`/`?court=` variants of the same venue are
    // one page to a search engine, not fourteen.
    alternates: { canonical: path },
    openGraph: {
      type: 'website',
      title,
      description,
      url: path,
      ...(venue.coverPhotoUrl ? { images: [venue.coverPhotoUrl] } : {}),
    },
  };
}

export default async function VenuePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const found = await readVenue(slug);
  if (!found) notFound();

  const { venue, clubSlug } = found;
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

  const [resources, { me, kind }] = await Promise.all([
    runAsSuperuser((db) => loadVenueAvailability(db, { venue: publicVenue, from, to })),
    playerChrome(),
  ]);
  const seed = toAvailability({ venue: publicVenue, from, to, resources });

  const booking = (
    <VenueBooking
      venue={{
        id: venue.id,
        name: venue.name,
        publicSlug: venue.publicSlug ?? slug,
        clubSlug,
        timezone: venue.timezone,
        cancellationCutoffHours: venue.cancellationCutoffHours,
      }}
      days={days}
      seed={{ day: pick.day, availability: seed }}
      initialPick={pick}
      renderedAt={now.toISOString()}
      viewer={kind === 'signed-out' ? 'signed-out' : kind}
    />
  );

  // The header and the tab bar come from (public)/layout.tsx (T20).
  return (
    <main className="bg-bg-page text-content-default safe-area-x flex-1">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-6 md:px-6 md:pt-6">
        <VenueHeader
          name={venue.name}
          addressLine={venue.addressLine}
          city={venue.city}
          sports={[...new Set(venue.resources.map((r) => r.sport))]}
        />
        {/* ViewerScope sends the signed-in user's id with the booking, so a
            tab left open across a switch to another account is refused 409
            VIEWER_CHANGED rather than booking as that account (#263). */}
        {me ? <ViewerScope viewerId={me.userId}>{booking}</ViewerScope> : booking}
      </div>
    </main>
  );
}
