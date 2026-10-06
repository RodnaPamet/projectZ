import { cache } from 'react';

import { formatInTimeZone } from 'date-fns-tz';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import {
  loadClubPublicPage,
  type ClubPage,
  type ClubPageVenue,
} from '@/app-layer/usecases/club-public-page';
import { loadVenueAvailability } from '@/app-layer/usecases/venue-availability';
import { slugSchema } from '@/app-layer/schemas/common';
import { toAvailability, type AvailabilityDto } from '@/app/api/v1/_lib/dto';
import { resolveAvailabilityRange } from '@/app/api/v1/_lib/range';
import { VenuePhotoImg } from '@/components/media/venue-photo-img';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ArrowLeft, LocationPin, MobilePhone } from '@/components/ui/icons/nucleo';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading, TextLink } from '@/components/ui/typography';
import { cn } from '@/lib/cn';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { cityLabel } from '@/lib/geo/cities';
import { buildClubJsonLd } from '@/lib/seo/club-jsonld';
import { clubPath, venuePath } from '@/lib/seo/sitemap';
import { absoluteUrl, siteUrl } from '@/lib/seo/site-url';
import { serializeJsonLd } from '@/lib/seo/venue-jsonld';

import { FreeToday } from './FreeToday';

/**
 * A club's public page, `/clubs/{slug}` (#356, Q42): the club, then a card for
 * EVERY venue it runs — even when there is only one — each linking to its own
 * page, `/venues/{publicSlug}` (#355).
 *
 * ═══ WHY /clubs/{slug} AND NOT /t/{slug} ═══
 *
 * `/t/{slug}/**` is the members' tenant namespace. The edge reads the slug out
 * of it (`tenantSlugFromPath`) and sends a signed-out visitor to sign in, the
 * route-permission table is anchored on it, and `/t/[slug]/layout.tsx` 404s
 * anyone who is not a member — so a public page there would need a carve-out
 * in the edge guard, whose public list over-EXPOSES when it is loose, and a
 * layout that stops gating its own children. `/clubs/{slug}` sits beside
 * `/venues/{publicSlug}` in the public group instead, under the guard's public
 * list like `/venues`. `/t/{slug}` still answers: staff go on to the admin,
 * everyone else is sent here (src/app/(app)/t/[slug]/page.tsx, and the edge
 * for a signed-out visitor), and `/t/{slug}/admin` is untouched.
 *
 * ═══ WHAT IT SHOWS ═══
 *
 * The name; the cover (#366: its first venue's that has one, else a tinted
 * band); the club's phone (or its
 * main venue's) and the main venue's address; the sports across all venues.
 * `VenueOrg` has no description column, so there is none (adding one is a
 * migration this page does not need). Then one card per venue: name, address,
 * sports, and its free times today.
 *
 * ═══ FREE TIMES TODAY, FROM THE VENUE PAGE'S OWN READ ═══
 *
 * Each card's times are `loadVenueAvailability` for today at the club, mapped
 * by `toAvailability` for the window `?date=` resolves to — the exact answer
 * `GET /api/v1/venues/{id}/availability?date=` gives, which is what the venue
 * page seeds its first day with. `FreeToday` holds it under that endpoint's
 * SWR key and revalidates after paint (T15), so a page served from the router
 * cache is corrected on arrival, and a tap through to the venue page finds
 * today already cached. A club runs a handful of venues; past
 * `LIVE_TIMES_VENUES` the rest show no times rather than make the page pay one
 * availability read per venue without limit.
 *
 * ═══ BYPASSRLS ═══
 *
 * As the venue page: a visitor has no tenant to bind, and `venue_org`,
 * `venue` and every availability table are FORCE row security.
 * `loadClubPublicPage` picks the public fields and filters on ACTIVE.
 */

/** Venues whose free times today are read on the server and revalidated. */
const LIVE_TIMES_VENUES = 10;

/** One club, read once per request by the metadata and the page alike. */
const readClub = cache(async (slug: string): Promise<ClubPage | null> => {
  if (!slugSchema.safeParse(slug).success) return null;
  return runAsSuperuser((db) => loadClubPublicPage(db, slug));
});

/** og:locale for the page's language. Crawlers send no cookie, so get `bg`. */
const OG_LOCALE: Record<string, string> = { bg: 'bg_BG', en: 'en_GB' };

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const club = await readClub(slug);
  // Not found renders the not-found page with 200 + noindex, for the reason
  // the venue page gives (a loading boundary has started the stream).
  if (!club) return { robots: { index: false } };

  const [t, tCities, locale] = await Promise.all([
    getTranslations('club'),
    getTranslations('cities'),
    getLocale(),
  ]);
  const main = club.venues[0];
  const title = t('metaTitle', { name: club.name });
  const description = t('metaDescription', {
    name: club.name,
    count: club.venues.length,
    city: main ? cityLabel(tCities, main.city) : 'none',
  });
  const path = clubPath(club.slug);
  const images = [club.cover?.url, club.logoUrl].filter((u): u is string => !!u);

  return {
    // Every absolute URL on the ONE canonical origin (SITE_URL; #396, Q47).
    metadataBase: siteUrl(),
    title,
    description,
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
    twitter: { card: club.cover ? 'summary_large_image' : 'summary', title, description },
  };
}

/** Today at the venue, as the availability endpoint would answer `?date=` for it. */
function todaySeed(venue: ClubPageVenue, now: Date) {
  const date = formatInTimeZone(now, venue.timezone, 'yyyy-MM-dd');
  const { from, to } = resolveAvailabilityRange(new URLSearchParams({ date }), venue.timezone, now);
  return { date, from, to };
}

export default async function ClubPublicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const club = await readClub(slug);
  if (!club) notFound();

  const now = new Date();
  const live = club.venues.slice(0, LIVE_TIMES_VENUES);
  const [seeds, t, tSports, tCities] = await Promise.all([
    runAsSuperuser(async (db) => {
      const out = new Map<string, { date: string; availability: AvailabilityDto }>();
      // One venue at a time: a transaction is one connection, and its queries
      // queue on it anyway.
      for (const v of live) {
        const { date, from, to } = todaySeed(v, now);
        const venue = { id: v.id, name: v.name, timezone: v.timezone };
        const resources = await loadVenueAvailability(db, { venue, from, to });
        out.set(v.id, { date, availability: toAvailability({ venue, from, to, resources }) });
      }
      return out;
    }),
    getTranslations('club'),
    getTranslations('sports'),
    getTranslations('cities'),
  ]);

  const main = club.venues[0];
  const sports = [...new Set(club.venues.flatMap((v) => v.sports))];
  const jsonLd = buildClubJsonLd({
    name: club.name,
    url: absoluteUrl(clubPath(club.slug)),
    phone: club.phone,
    logoUrl: club.logoUrl,
    images: club.cover ? [club.cover.url] : [],
    address: main ?? null,
    venues: club.venues.map((v) => ({
      name: v.name,
      url: absoluteUrl(venuePath(v.publicSlug)),
      addressLine: v.addressLine,
      city: v.city,
      country: v.country,
      sports: v.sports.map((s) => tSports(s)),
      image: v.cover?.url ?? null,
    })),
  });
  const place = (v: { addressLine: string; city: string }) =>
    `${v.addressLine}, ${cityLabel(tCities, v.city)}`;

  // The header and the tab bar come from (public)/layout.tsx (T20).
  return (
    <main className="bg-bg-page text-content-default safe-area-x flex-1">
      {/* Structured data, in the server HTML. A data block, not a script:
          browsers never execute `application/ld+json`. serializeJsonLd
          escapes `<`, so no club or venue name can close the element. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-6 md:px-6 md:pt-6">
        <header className="flex flex-col gap-4">
          {/* The cover (#366): the first venue's photo that has one, else a
              token-tinted band. The back link is the page's own way to the
              index, not navigation chrome. */}
          <div
            className={cn(
              'bg-bg-success relative overflow-hidden md:rounded-lg',
              club.cover ? 'h-48 md:h-64' : 'h-32 md:h-40',
            )}
          >
            {club.cover && (
              <VenuePhotoImg
                photo={club.cover}
                sizes="(min-width: 768px) 720px, 100vw"
                className="absolute inset-0 size-full"
                priority
              />
            )}
            <Link
              href="/venues"
              aria-label={t('back')}
              className={cn(
                buttonVariants({ variant: 'secondary', size: 'icon' }),
                'absolute top-3 left-4 md:left-3',
              )}
            >
              <ArrowLeft aria-hidden="true" />
            </Link>
          </div>

          <div className="flex flex-col gap-2 px-6 md:px-0">
            <Heading level={1}>{club.name}</Heading>
            {(main || club.phone) && (
              <ul aria-label={t('contactLabel')} className="flex flex-col gap-1">
                {main && (
                  <li>
                    <Caption className="flex items-center gap-1">
                      <LocationPin className="size-3.5 shrink-0" aria-hidden="true" />
                      {place(main)}
                    </Caption>
                  </li>
                )}
                {club.phone && (
                  <li>
                    <Caption className="flex items-center gap-1">
                      <MobilePhone className="size-3.5 shrink-0" aria-hidden="true" />
                      <TextLink tone="link" href={`tel:${club.phone.replace(/[^\d+]/g, '')}`}>
                        {t('phone', { phone: club.phone })}
                      </TextLink>
                    </Caption>
                  </li>
                )}
              </ul>
            )}
            {sports.length > 0 && (
              <ul aria-label={t('sportsLabel')} className="flex flex-wrap gap-1">
                {sports.map((s) => (
                  <li key={s}>
                    <StatusBadge variant="neutral" icon={null}>
                      {tSports(s)}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </header>

        <section aria-labelledby="club-venues" className="flex flex-col gap-3 px-6 md:px-0">
          <div className="flex items-baseline justify-between gap-2">
            <Heading level={2} id="club-venues">
              {t('venuesTitle')}
            </Heading>
            <Caption>{t('venuesCount', { count: club.venues.length })}</Caption>
          </div>

          {club.venues.length === 0 ? (
            <div data-perf-ready>
              <EmptyState title={t('noVenues.title')} description={t('noVenues.description')} />
            </div>
          ) : (
            <ul data-perf-ready className="grid gap-4 sm:grid-cols-2">
              {club.venues.map((v) => {
                const seed = seeds.get(v.id);
                return (
                  <Card
                    key={v.id}
                    as="li"
                    elevation="flat"
                    density="compact"
                    className="bg-bg-default focus-within:ring-ring relative flex flex-col gap-2 focus-within:ring-2"
                  >
                    {v.cover && (
                      <VenuePhotoImg
                        photo={v.cover}
                        sizes="(min-width: 640px) 340px, 100vw"
                        className="bg-bg-muted aspect-[16/9] w-full rounded-md"
                      />
                    )}
                    <h3 className="text-content-emphasis font-medium">
                      {/* Default (auto) prefetch, as /venues' cards
                          (docs/perf/navigation-policy.md): the venue page's
                          loading.tsx shell, so a tap paints its skeleton at
                          once. The name stretches over the card, so the whole
                          card is the target and one link is announced. */}
                      <Link
                        href={venuePath(v.publicSlug)}
                        className="outline-none after:absolute after:inset-0 after:rounded-[inherit] hover:underline"
                      >
                        {v.name}
                      </Link>
                    </h3>
                    <Caption className="flex items-center gap-1">
                      <LocationPin className="size-3.5 shrink-0" aria-hidden="true" />
                      {place(v)}
                    </Caption>
                    {v.sports.length > 0 && (
                      <ul aria-label={t('sportsLabel')} className="flex flex-wrap gap-1">
                        {v.sports.map((s) => (
                          <li key={s}>
                            <StatusBadge variant="neutral" icon={null}>
                              {tSports(s)}
                            </StatusBadge>
                          </li>
                        ))}
                      </ul>
                    )}
                    {seed && (
                      <FreeToday
                        venueId={v.id}
                        timezone={v.timezone}
                        date={seed.date}
                        seed={seed.availability}
                        renderedAt={now.toISOString()}
                      />
                    )}
                  </Card>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
