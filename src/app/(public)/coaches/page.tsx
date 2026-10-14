import type { Metadata } from 'next';
import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';

import { listPublicCoaches, publicCoachSports } from '@/app-layer/usecases/coach-directory';
import { CoachCard } from '@/components/coaches/CoachCard';
import { coachesCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { chromeIdentity } from '@/components/layout/player-chrome-data';
import { buttonVariants } from '@/components/ui/button-variants';
import { EmptyState } from '@/components/ui/empty-state';
import { Caption, Heading } from '@/components/ui/typography';
import { cn } from '@/lib/cn';
import { COACHES_HREF } from '@/lib/coaches/hrefs';
import { cityLabel } from '@/lib/geo/cities';
import { siteUrl } from '@/lib/seo/site-url';
import { isSportKey } from '@/lib/sports/registry';

/**
 * /coaches — «Треньори»: the coaches a player can book (#547; owner decision
 * 10). Public, and the same for everyone: nothing here depends on who is
 * looking.
 *
 * Rendered whole on the server, with no script of its own: the sport filter
 * and "next" are links (`?sport=`, `?after=`), so the page works without
 * JavaScript and every state of it has an address. Who is listed is
 * `listPublicCoaches`'s rule, not this page's.
 */

type Search = { sport?: string | string[]; after?: string | string[] };
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Search>;
}): Promise<Metadata> {
  const [t, sp] = await Promise.all([getTranslations('coaches'), searchParams]);
  return {
    metadataBase: siteUrl(),
    title: t('metaTitle'),
    description: t('metaDescription'),
    alternates: { canonical: COACHES_HREF },
    // One list, one address for search engines: a filtered or later page is
    // the same people in another order.
    ...(one(sp.sport) || one(sp.after) ? { robots: { index: false, follow: true } } : {}),
  };
}

export default async function CoachesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const rawSport = one(sp.sport);
  const sport = rawSport && isSportKey(rawSport) ? rawSport : undefined;
  const rawAfter = one(sp.after);
  const after = rawAfter && /^[a-z0-9][a-z0-9-]{1,63}$/.test(rawAfter) ? rawAfter : null;

  const [t, tNav, tSports, tCities, format, me, { items, nextCursor }, sports] = await Promise.all([
    getTranslations('coaches'),
    getTranslations('common.nav'),
    getTranslations('sports'),
    getTranslations('cities'),
    getFormatter(),
    chromeIdentity(),
    listPublicCoaches({ sport, cursor: after }),
    publicCoachSports(),
  ]);

  const href = (q: { sport?: string; after?: string }) => {
    const params = new URLSearchParams();
    if (q.sport) params.set('sport', q.sport);
    if (q.after) params.set('after', q.after);
    const qs = params.toString();
    return qs ? `${COACHES_HREF}?${qs}` : COACHES_HREF;
  };
  const chip = (active: boolean) =>
    cn(buttonVariants({ variant: active ? 'primary' : 'secondary', size: 'sm' }), 'shrink-0');

  return (
    <div className="bg-bg-page text-content-default safe-area-x">
      <div className="in-shell:p-0 mx-auto w-full max-w-3xl px-6 py-10">
        {me ? <PageBreadcrumbs items={coachesCrumbs(tNav)} className="hidden" /> : null}
        <Heading level={1}>{t('title')}</Heading>
        <Caption className="mt-2 block max-w-prose">{t('intro')}</Caption>

        {sports.length > 1 ? (
          <nav
            aria-label={t('filterLabel')}
            className="mt-6 flex flex-wrap gap-2"
            data-testid="coaches-sports"
          >
            <Link
              href={href({})}
              className={chip(!sport)}
              aria-current={!sport ? 'page' : undefined}
            >
              {t('allSports')}
            </Link>
            {sports.map((s) => (
              <Link
                key={s}
                href={href({ sport: s })}
                className={chip(sport === s)}
                aria-current={sport === s ? 'page' : undefined}
              >
                {tSports(s as never)}
              </Link>
            ))}
          </nav>
        ) : null}

        {items.length === 0 ? (
          <div className="mt-8">
            <EmptyState
              title={t('empty.title')}
              description={sport ? t('empty.sport') : t('empty.description')}
            />
          </div>
        ) : (
          <ul className="mt-6 grid gap-3" data-testid="coaches-list">
            {items.map((c) => (
              <li key={c.slug} className="grid">
                <CoachCard
                  slug={c.slug}
                  name={c.name?.trim() || t('noName')}
                  avatarUrl={c.avatarUrl}
                  sports={c.sports.map((s) => tSports(s.sport as never))}
                  line={
                    c.fromRateCents === null
                      ? null
                      : t('from', {
                          price: format.number(c.fromRateCents / 100, {
                            style: 'currency',
                            currency: c.currency,
                          }),
                        })
                  }
                  places={[
                    ...new Set(c.venues.map((v) => `${v.name}, ${cityLabel(tCities, v.city)}`)),
                  ]
                    .slice(0, 2)
                    .join(' · ')}
                />
              </li>
            ))}
          </ul>
        )}

        {nextCursor || after ? (
          <div className="mt-6 flex flex-wrap gap-2">
            {after ? (
              <Link href={href({ sport })} className={chip(false)}>
                {t('first')}
              </Link>
            ) : null}
            {nextCursor ? (
              <Link
                href={href({ sport, after: nextCursor })}
                className={chip(false)}
                data-testid="coaches-next"
              >
                {t('next')}
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
