import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { clubAdminCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { Heading } from '@/components/ui/typography';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';
import { combineNouns } from '@/lib/sports/resource-kinds';

import { DayGrid } from './DayGrid';
import { loadDiaryDay } from './diary-day';

export async function generateMetadata() {
  const t = await getTranslations('admin.calendar');
  return { title: t('metaTitle') };
}

/**
 * The club's diary for one day. What a day looks like is built in
 * `diary-day.ts`, which the grid's own stale-data refresh calls too (#314).
 */
export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ day?: string }>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);

  const result = await resolveTenantPageContext(slug);
  if (result.kind !== 'ok') notFound();

  const { ctx } = result;
  if (!ctx.permissions.includes('bookings.view_all')) notFound();

  const [t, tCommon, locale] = await Promise.all([
    getTranslations('admin.calendar'),
    getTranslations('common'),
    getLocale(),
  ]);

  // `?day=` exactly as the URL has it: the grid asks for the same day again
  // when it refreshes itself, and no `?day=` means the club's today then too.
  const requestedDay = typeof sp.day === 'string' ? sp.day : null;

  const day = await loadDiaryDay(ctx.tenantId, requestedDay, {
    locale,
    labels: {
      unknownPlayer: t('unknownPlayer'),
      guest: t('guest'),
      deletedUser: tCommon('deletedUser'),
    },
  });

  // "всички писти" at a karting club (P51).
  const nouns = combineNouns(day.courts.map((c) => c.noun));

  const tNav = await getTranslations('common.nav');

  return (
    <section>
      <PageBreadcrumbs items={clubAdminCrumbs(slug, tNav, 'calendar')} />
      <header className="mb-section">
        <Heading level={1}>{t('title')}</Heading>
        <p className="text-content-muted mt-1 text-sm">
          {t(
            nouns === 'track'
              ? 'track.subtitle'
              : nouns === 'mixed'
                ? 'mixed.subtitle'
                : 'subtitle',
          )}
        </p>
      </header>

      {/*
        `day.renderedAt` is the payload's identity for useRefreshWhenStale: a
        revisit served from the router cache (up to staleTimes.dynamic = 30 s
        old) carries this same value, and re-fetches the day once it is older
        than 10 s.
      */}
      {/*
        ViewerScope: the desk's writes go to /api/v1 (#364) carrying the user
        this page was rendered for, so a tab left open after another account
        signed in is refused (409 VIEWER_CHANGED) instead of booking as them.
      */}
      <ViewerScope viewerId={ctx.userId}>
        <DayGrid slug={slug} requestedDay={requestedDay} day={day} />
      </ViewerScope>
    </section>
  );
}
