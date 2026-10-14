import { cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';

import { publicCoachBySlug } from '@/app-layer/usecases/coach-directory';
import { coachesCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { chromeIdentity } from '@/components/layout/player-chrome-data';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { Caption, Heading } from '@/components/ui/typography';
import { coachPath } from '@/lib/coaches/hrefs';
import { cityLabel } from '@/lib/geo/cities';
import { buildCoachJsonLd } from '@/lib/seo/coach-jsonld';
import { venuePath } from '@/lib/seo/sitemap';
import { absoluteUrl, siteUrl } from '@/lib/seo/site-url';
import { serializeJsonLd } from '@/lib/seo/venue-jsonld';

/**
 * /coaches/{slug} — one coach's public page (#547; owner decision 10): who
 * they are, what they teach, and where a lesson can be booked with them and
 * for how much.
 *
 * Any coach the platform approved has one. One who teaches nowhere yet is
 * told as such and kept out of search engines; one who is not approved, or
 * whose account is gone, is a 404. Everything on it is what the platform
 * approved for publication (`coach-directory.ts`): no address, no phone,
 * nothing of the certificate.
 *
 * Booking a lesson from here arrives with #548; today the page says where and
 * for how much, and links to each venue.
 */
const readCoach = cache((slug: string) => publicCoachBySlug(slug));

const OG_LOCALE: Record<string, string> = { bg: 'bg_BG', en: 'en_GB' };

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const coach = await readCoach(slug);
  if (!coach) return { robots: { index: false } };
  const [t, tSports, locale] = await Promise.all([
    getTranslations('coaches'),
    getTranslations('sports'),
    getLocale(),
  ]);
  const name = coach.name?.trim() || t('noName');
  const title = t('page.metaTitle', { name });
  const description = t('page.metaDescription', {
    name,
    sports: coach.sports.map((s) => tSports(s.sport as never)).join(', '),
  });
  const path = coachPath(coach.slug);
  return {
    metadataBase: siteUrl(),
    title,
    description,
    alternates: { canonical: path },
    // Nothing to book: a page that exists, and is not what a search should find.
    ...(coach.venues.length === 0 ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      type: 'profile',
      siteName: 'playerz.bg',
      locale: OG_LOCALE[locale] ?? OG_LOCALE.bg,
      title,
      description,
      url: path,
      ...(coach.avatarUrl ? { images: [coach.avatarUrl] } : {}),
    },
    twitter: { card: 'summary', title, description },
  };
}

export default async function CoachPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const coach = await readCoach(slug);
  if (!coach) notFound();

  const [t, tNav, tSports, tCities, format, me] = await Promise.all([
    getTranslations('coaches'),
    getTranslations('common.nav'),
    getTranslations('sports'),
    getTranslations('cities'),
    getFormatter(),
    chromeIdentity(),
  ]);
  const name = coach.name?.trim() || t('noName');
  const money = (cents: number, currency: string) =>
    format.number(cents / 100, { style: 'currency', currency });

  const jsonLd = buildCoachJsonLd({
    url: absoluteUrl(coachPath(coach.slug)),
    name,
    jobTitle: t('page.jobTitle'),
    image: coach.avatarUrl,
    description: coach.bio,
    sports: coach.sports.map((s) => tSports(s.sport as never)),
    venues: coach.venues.map((v) => ({
      name: v.name,
      url: v.publicSlug ? absoluteUrl(venuePath(v.publicSlug)) : null,
    })),
  });

  return (
    <div className="bg-bg-page text-content-default safe-area-x flex-1">
      {/* Structured data, in the server HTML. A data block, never executed;
          serializeJsonLd escapes `<`, so no name or text can close it. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />
      <div
        className="in-shell:p-0 mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10"
        data-testid="coach-page"
      >
        {me ? <PageBreadcrumbs items={coachesCrumbs(tNav, name)} className="hidden" /> : null}

        <header className="flex items-center gap-4">
          <InitialsAvatar value={name} size="lg" imageUrl={coach.avatarUrl} />
          <div className="min-w-0">
            <Heading level={1}>{name}</Heading>
            <Caption>{t('page.jobTitle')}</Caption>
          </div>
        </header>

        <section aria-labelledby="coach-sports" className="flex flex-col gap-2">
          <Heading level={2} id="coach-sports" className="text-lg">
            {t('page.teaches')}
          </Heading>
          <ul className="text-sm" data-testid="coach-page-sports">
            {coach.sports.map((s) => (
              <li key={s.sport}>
                {s.levelMin === s.levelMax
                  ? t('page.sportOne', { sport: tSports(s.sport as never), level: s.levelMin })
                  : t('page.sportRange', {
                      sport: tSports(s.sport as never),
                      min: s.levelMin,
                      max: s.levelMax,
                    })}
              </li>
            ))}
          </ul>
        </section>

        {coach.bio ? (
          <section aria-labelledby="coach-about" className="flex flex-col gap-2">
            <Heading level={2} id="coach-about" className="text-lg">
              {t('page.about')}
            </Heading>
            <p className="max-w-prose text-sm whitespace-pre-wrap">{coach.bio}</p>
          </section>
        ) : null}

        {coach.qualifications ? (
          <section aria-labelledby="coach-qualifications" className="flex flex-col gap-2">
            <Heading level={2} id="coach-qualifications" className="text-lg">
              {t('page.qualifications')}
            </Heading>
            <p className="max-w-prose text-sm whitespace-pre-wrap">{coach.qualifications}</p>
          </section>
        ) : null}

        <section aria-labelledby="coach-venues" className="flex flex-col gap-3">
          <Heading level={2} id="coach-venues" className="text-lg">
            {t('page.venues')}
          </Heading>
          {coach.venues.length === 0 ? (
            <p className="text-content-muted text-sm" data-testid="coach-page-nowhere">
              {t('page.nowhere')}
            </p>
          ) : (
            <>
              <ul className="grid gap-3" data-testid="coach-page-venues">
                {coach.venues.map((v) => (
                  <li
                    key={v.linkId}
                    className="border-border-subtle bg-bg-default rounded-lg border p-3"
                    data-testid="coach-page-venue"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      {v.publicSlug ? (
                        <Link
                          href={venuePath(v.publicSlug)}
                          className="text-content-emphasis text-sm font-medium underline-offset-4 hover:underline"
                        >
                          {v.name}
                        </Link>
                      ) : (
                        <span className="text-content-emphasis text-sm font-medium">{v.name}</span>
                      )}
                      <span className="text-sm">
                        {t('page.rate', { price: money(v.hourlyRateCents, v.currency) })}
                      </span>
                    </div>
                    <Caption className="block">
                      {t('page.at', { club: v.club.name, city: cityLabel(tCities, v.city) })}
                    </Caption>
                    <Caption className="block">
                      {[
                        t('page.lengths', { lengths: v.lessonMinutes.join(', ') }),
                        ...(v.groupRateCents === null
                          ? []
                          : [t('page.groupRate', { price: money(v.groupRateCents, v.currency) })]),
                      ].join(' · ')}
                    </Caption>
                  </li>
                ))}
              </ul>
              <Caption>{t('page.courtNote')}</Caption>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
