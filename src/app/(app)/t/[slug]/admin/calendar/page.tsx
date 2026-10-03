import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import { Heading } from '@/components/ui/typography';
import { resolveTenantPageContext } from '@/lib/auth/page-context';

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

  const [t, locale] = await Promise.all([getTranslations('admin.calendar'), getLocale()]);

  // `?day=` exactly as the URL has it: the grid asks for the same day again
  // when it refreshes itself, and no `?day=` means the club's today then too.
  const requestedDay = typeof sp.day === 'string' ? sp.day : null;

  const day = await loadDiaryDay(ctx.tenantId, requestedDay, {
    locale,
    labels: { unknownPlayer: t('unknownPlayer'), guest: t('guest') },
  });

  return (
    <section>
      <header className="mb-section">
        <Heading level={1}>{t('title')}</Heading>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      {/*
        `day.renderedAt` is the payload's identity for useRefreshWhenStale: a
        revisit served from the router cache (up to staleTimes.dynamic = 30 s
        old) carries this same value, and re-fetches the day once it is older
        than 10 s.
      */}
      <DayGrid slug={slug} requestedDay={requestedDay} day={day} />
    </section>
  );
}
