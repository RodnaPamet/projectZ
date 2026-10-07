import { cache, Suspense } from 'react';

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { getVenueByPublicSlug } from '@/app-layer/repositories/venue';
import { splitPhotos } from '@/lib/media/photo-view';
import { cityLabel } from '@/lib/geo/cities';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { venuePath } from '@/lib/seo/sitemap';
import { countPageUsage } from '@/lib/usage/record';
import { absoluteUrl, siteUrl } from '@/lib/seo/site-url';
import { buildVenueJsonLd, serializeJsonLd } from '@/lib/seo/venue-jsonld';

import { isPublicSlug } from './booking-days';
import { VenueGallery } from './VenueGallery';
import { VenueHeader } from './VenueHeader';
import { VenueSlots, VenueSlotsSkeleton } from './VenueSlots';

/**
 * The venue page, `/venues/{publicSlug}` (#355, audit A01): who the venue is,
 * then a day picker and every court's free times, and "Резервирай".
 *
 * ═══ ADDRESSED BY `publicSlug`, NOT `slug` OR `id` ═══
 *
 * `venue.slug` is unique only within its club, so `/venues/central-courts`
 * could name two venues. `publicSlug` (P41) is unique everywhere and readable,
 * which is what a URL people share and search engines index wants. The v1 API
 * keeps addressing venues by id; this page reads them by `publicSlug` itself.
 *
 * ═══ TWO STAGES: THE HEADER, THEN THE SLOTS (#403) ═══
 *
 * The header (one venue row, `readVenue`) renders in the page's shell. The day
 * picker and the first day's slots (`VenueSlots`, which computes them) wait
 * behind their own Suspense boundary with their own skeleton, so a slow
 * availability read never holds the venue's name back. `loading.tsx` still
 * paints the whole page's skeleton on the tap (T12): it is what the cards'
 * auto prefetch fetches.
 *
 * On a cold client-side navigation from a venue card the header still paints
 * with the slots, measured (#403). Every part of it is a client component
 * (the vendored Heading, Caption and StatusBadge, next/link), and Turbopack
 * maps each such reference to the page's whole chunk list, so the header
 * needs the page's JS chunk; and content that follows a skeleton is held by
 * React's 300 ms reveal throttle (#290). The chunk was the longer wait on the
 * phone profile, so the skeleton now preloads it (VenueBackLink). The split
 * pays off where the slots are slow: the shell of a full page load, and a
 * slow availability read, never hold the venue's name back.
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
  // app_user this would find nothing. `publicVenueFilter` in the repository
  // (the venue ACTIVE, its club ACTIVE: a suspended club's venue is a 404,
  // #298) and the fields picked below are what keep it public-safe. The club's
  // slug (what `POST /t/{slug}/bookings` takes) shares the transaction:
  // `venue.tenantId` is not a foreign key, so a venue whose club is gone is a
  // 404 here as it is on the API.
  return runAsSuperuser(async (db) => {
    const venue = await getVenueByPublicSlug(db, publicSlug);
    if (!venue) return null;
    const club = await db.venueOrg.findUnique({
      where: { id: venue.tenantId },
      select: { slug: true },
    });
    if (!club) return null;
    return { venue, clubSlug: club.slug };
  });
});

/** og:locale for the page's language. Crawlers send no cookie, so get `bg`. */
const OG_LOCALE: Record<string, string> = { bg: 'bg_BG', en: 'en_GB' };

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const found = await readVenue(slug);
  // The page renders the not-found page (notFound below), which names itself.
  // Its status is 200, not 404: a loading boundary has started the stream
  // before the venue is read, and a status cannot change mid-stream, so Next
  // marks the page `noindex` instead (Next's streaming guide, "The HTTP
  // contract"). An unknown slug is therefore never indexed.
  //
  // Calling notFound() HERE does not change that, for any user agent — tried
  // against a production build (#396): browsers, Googlebot, and the
  // HTML-limited bots whose metadata Next resolves before streaming (Bingbot,
  // Twitterbot) all got 200 + noindex. The boundary is not only this
  // segment's loading.tsx but also `venues/loading.tsx`, which wraps every
  // segment below it, so no await anywhere under /venues runs before the
  // status is sent. A real 404 needs the check before rendering starts, in
  // src/middleware.ts — which runs on the edge, without Prisma; Next 16's
  // Node `proxy.ts` could, at the price of a database read in front of the
  // render on every request. Google treats noindex like a 404 here. See #396.
  if (!found) return { robots: { index: false } };
  const [t, tCities, locale] = await Promise.all([
    getTranslations('venue'),
    getTranslations('cities'),
    getLocale(),
  ]);

  const { venue } = found;
  const title = t('metaTitle', { name: venue.name });
  const description = t('metaDescription', {
    name: venue.name,
    address: venue.addressLine,
    // In the page's language (#368): a stored `Sofia` reads `София` in Bulgarian.
    city: cityLabel(tCities, venue.city),
  });
  const path = venuePath(venue.publicSlug ?? slug);
  const images = venueImages(venue);

  return {
    // Every absolute URL below (canonical, og:url, og:image) is on the ONE
    // canonical origin (SITE_URL, else NEXTAUTH_URL; src/lib/seo/site-url.ts),
    // not whichever host this request came in on (#396, Q47).
    metadataBase: siteUrl(),
    title,
    description,
    // One canonical address: `?day=`/`?court=` variants of the same venue are
    // one page to a search engine, not fourteen.
    //
    // No `alternates.languages`: BG and EN are the SAME URL here, chosen by a
    // cookie (Q12, #368). hreflang maps a language to a DIFFERENT URL; two
    // entries naming this one URL contradict each other and search engines
    // drop them. It belongs with per-language URLs, if those are ever made.
    alternates: { canonical: path },
    openGraph: {
      type: 'website',
      siteName: 'playerz.bg',
      locale: OG_LOCALE[locale] ?? OG_LOCALE.bg,
      title,
      description,
      url: path,
      ...(images.length > 0 ? { images } : {}),
    },
    twitter: {
      card: images.length > 0 ? 'summary_large_image' : 'summary',
      title,
      description,
    },
  };
}

/**
 * The cover first, then the gallery (#366), as absolute URLs of each photo's
 * default rendition. A pre-#366 `coverPhotoUrl` with no photo row still counts.
 */
function venueImages(venue: FoundVenue) {
  const { cover, gallery } = splitPhotos(venue.photos);
  return [...new Set([cover?.url ?? venue.coverPhotoUrl, ...gallery.map((p) => p.url)])].filter(
    (u): u is string => !!u,
  );
}

export default async function VenuePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const found = await readVenue(slug);
  if (!found) notFound();

  const { venue, clubSlug } = found;
  const publicSlug = venue.publicSlug ?? slug;
  // The funnel's venue-page step (#371): anonymous, counted after the response.
  await countPageUsage('VENUE_VIEW', { venueId: venue.id });
  const sports = [...new Set(venue.resources.map((r) => r.sport))];
  const jsonLd = await venueJsonLd(venue, sports, venuePath(publicSlug));
  const { cover, gallery } = splitPhotos(venue.photos);
  const tCities = await getTranslations('cities');

  // The header and the tab bar come from (public)/layout.tsx (T20).
  return (
    <main className="bg-bg-page text-content-default safe-area-x flex-1">
      {/* Structured data (#396), in the server HTML. A data block, not a
          script: browsers never execute `application/ld+json`, so script-src
          does not apply to it. serializeJsonLd escapes `<`, so no venue name
          can close the element. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-6 md:px-6 md:pt-6">
        <VenueHeader
          name={venue.name}
          addressLine={venue.addressLine}
          city={cityLabel(tCities, venue.city)}
          sports={sports}
          cover={cover}
        />
        {/* The second stage (#403): only the slots wait for the day's
            availability; the header above is already on screen. */}
        <Suspense fallback={<VenueSlotsSkeleton />}>
          <VenueSlots
            venue={{
              id: venue.id,
              name: venue.name,
              publicSlug,
              timezone: venue.timezone,
              cancellationCutoffHours: venue.cancellationCutoffHours,
            }}
            clubSlug={clubSlug}
            searchParams={searchParams}
          />
        </Suspense>
        {gallery.length > 0 && <VenueGallery name={venue.name} photos={gallery} />}
      </div>
    </main>
  );
}

type FoundVenue = NonNullable<Awaited<ReturnType<typeof readVenue>>>['venue'];

/** The page's SportsActivityLocation, in the page's language. */
async function venueJsonLd(venue: FoundVenue, sports: string[], path: string) {
  const [tSports, locale] = await Promise.all([getTranslations('sports'), getLocale()]);
  return buildVenueJsonLd({
    name: venue.name,
    description: venue.description,
    addressLine: venue.addressLine,
    city: venue.city,
    country: venue.country,
    lat: venue.lat,
    lng: venue.lng,
    phone: venue.phone,
    url: absoluteUrl(path),
    images: venueImages(venue),
    sports: sports.map((s) => tSports(s as never)),
    courts: venue.resources,
    locale,
  });
}
