import type { Metadata } from 'next';
import { unstable_rethrow } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { loadPilotClubs, type PilotClub } from '@/app-layer/usecases/pilot-clubs';
import { PublicPrefetchLink } from '@/components/layout/PublicPrefetchLink';
import { PlayerChrome } from '@/components/layout/player-chrome';
import { buttonVariants } from '@/components/ui/button-variants';
import { ArrowRight } from '@/components/ui/icons/nucleo';
import { StatusBadge } from '@/components/ui/status-badge';
import { Eyebrow, Heading } from '@/components/ui/typography';
import { logger } from '@/lib/observability/logger';
import { siteGraph } from '@/lib/seo/site-jsonld';
import { siteUrl } from '@/lib/seo/site-url';
import { serializeJsonLd } from '@/lib/seo/venue-jsonld';

import {
  ClosingSection,
  ForClubsSection,
  PilotClubsSection,
  PlayersSection,
} from './LandingSections';

/**
 * The landing page at `/` (#369, Q45/Q49): the public face of playerz.bg.
 *
 * Two audiences, one page: players (find and book a court in Sofia, instant
 * confirmation, pay at the club, every court sport) and clubs (fill empty
 * slots, one diary, the first 2 months free, and a contact form). Between
 * them, the pilot clubs, read live: active clubs with a public venue, never
 * invented ones.
 *
 * The copy is a DRAFT for the owner to edit: every word is in `landing.*` in
 * messages/{bg,en}.json, nothing is written here.
 *
 * ═══ FAST ON A PHONE ═══
 *
 * Server-rendered, with one database read (the pilot clubs) and no client
 * component of its own except the contact form. Its First Load JS budget is in
 * docs/perf/bundle-budget.json and the reasoning in the PR (#369).
 *
 * ═══ THE ONE FULL PREFETCH ═══
 *
 * "Намери корт" is the page's `PublicPrefetchLink` to /venues (#290, T30):
 * the router has /venues before the tap. The header's /login is the other.
 * Every other link here keeps the default (auto) prefetch, and
 * tests/guardrails/router-cache-policy.test.ts pins exactly that.
 *
 * ═══ THE LANGUAGE ═══
 *
 * Whatever the request resolves (`NEXT_LOCALE`, seeded from the user's
 * preference when signed in, the footer's switch when not; #368). Crawlers send
 * no cookie and get Bulgarian.
 */

/** og:locale for the page's language. */
const OG_LOCALE: Record<string, string> = { bg: 'bg_BG', en: 'en_GB' };

/**
 * The privacy page. It arrives with #370; until then the link 404s, which the
 * owner accepted (#369). A plain `<a>`, so nothing prefetches it meanwhile.
 */
const PRIVACY_HREF = '/privacy';

/** Sports the hero names. A sample of the catalogue, not a claim about any club. */
const HERO_SPORTS = [
  'PADEL',
  'TENNIS',
  'FOOTBALL5',
  'BASKETBALL',
  'VOLLEYBALL',
  'BADMINTON',
] as const;

export async function generateMetadata(): Promise<Metadata> {
  const [t, locale] = await Promise.all([getTranslations('landing'), getLocale()]);
  const title = t('metaTitle');
  const description = t('metaDescription');
  return {
    // Every absolute URL on the ONE canonical origin (SITE_URL; #401, Q47).
    metadataBase: siteUrl(),
    // Absolute: the root layout has no title template, and this is the brand page.
    title: { absolute: title },
    description,
    alternates: { canonical: '/' },
    openGraph: {
      type: 'website',
      siteName: 'playerz.bg',
      locale: OG_LOCALE[locale] ?? OG_LOCALE.bg,
      title,
      description,
      url: '/',
    },
    twitter: { card: 'summary', title, description },
  };
}

async function pilotClubs(): Promise<PilotClub[]> {
  try {
    return await loadPilotClubs();
  } catch (err) {
    // Next's own control flow is not an error.
    unstable_rethrow(err);
    // The shop window renders whatever the database is doing: the section
    // then shows its "coming soon" state.
    logger.warn('landing: pilot clubs not read', {
      component: 'landing',
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export default async function HomePage() {
  const [t, tSports, locale, clubs] = await Promise.all([
    getTranslations('landing'),
    getTranslations('sports'),
    getLocale(),
    pilotClubs(),
  ]);

  const jsonLd = siteGraph({
    origin: siteUrl(),
    name: 'playerz.bg',
    description: t('metaDescription'),
    language: locale,
  });

  return (
    // The home page is in the `(home)` group, not under a layout, so it wears
    // the player chrome itself (T20), with the footer and its language switch.
    <PlayerChrome footer>
      <main className="bg-bg-page text-content-default safe-area-x flex-1">
        {/* Structured data in the server HTML: a data block, never executed.
            serializeJsonLd escapes `<`, so no copy can close the element. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
        />

        <section
          aria-labelledby="landing-hero"
          className="border-border-subtle border-b"
          data-testid="landing-hero"
        >
          <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-6 py-14 md:grid-cols-[1.15fr_1fr] md:py-24">
            <div className="flex flex-col items-start gap-5">
              <Eyebrow className="text-content-brand mb-0">{t('hero.eyebrow')}</Eyebrow>
              {/* The vendored Heading, scaled up for the one page that is a
                  poster. Colour and weight stay the primitive's. */}
              <Heading
                level={1}
                id="landing-hero"
                className="text-4xl leading-[1.1] text-balance sm:text-5xl lg:text-6xl"
              >
                {t('hero.title')}
              </Heading>
              <p className="text-content-default max-w-xl text-lg text-pretty">{t('hero.lead')}</p>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                {/* data-perf-ready: the perf harness's "content is on screen"
                    marker (docs/perf/README.md). Fully prefetched (#290). The
                    primary button's own recipe, as before. */}
                <PublicPrefetchLink
                  href="/venues"
                  data-perf-ready
                  data-testid="landing-find-court"
                  className={buttonVariants({ variant: 'primary', size: 'lg' })}
                >
                  {t('hero.cta')}
                  <ArrowRight aria-hidden="true" />
                </PublicPrefetchLink>
                {/* An in-page anchor: no route, nothing to prefetch. */}
                <a href="#clubs" className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
                  {t('hero.forClubs')}
                </a>
              </div>
            </div>

            {/* The court: drawn from tokens, decorative. No stock image and no
                external host; club photos (#366) appear on the club cards.
                From md only: on a phone the copy and the button lead. */}
            <div aria-hidden="true" className="relative mx-auto hidden w-full max-w-md md:block">
              {/* A court from above: the net across the middle, a service
                  line each side of it, the centre line between them. */}
              <div className="border-brand-default bg-brand-subtle relative aspect-[10/7] overflow-hidden rounded-2xl border-2">
                <div className="border-brand-default absolute inset-y-0 left-1/2 border-l-4" />
                <div className="border-brand-default absolute inset-y-0 right-[22%] left-[22%] border-x-2" />
                <div className="border-brand-default absolute top-1/2 right-[22%] left-[22%] border-t-2" />
              </div>
            </div>
            <ul
              aria-label={t('hero.sportsLabel')}
              className="flex flex-wrap gap-2 md:col-span-2 md:justify-center"
            >
              {HERO_SPORTS.map((s) => (
                <li key={s}>
                  <StatusBadge variant="neutral" icon={null}>
                    {tSports(s)}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <PlayersSection />
        <PilotClubsSection clubs={clubs} />
        <ForClubsSection privacyHref={PRIVACY_HREF} />
        <ClosingSection />
      </main>
    </PlayerChrome>
  );
}
