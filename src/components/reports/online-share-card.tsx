import { useFormatter, useTranslations } from 'next-intl';

import type { ClubOnlineShare } from '@/app-layer/usecases/usage-report';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';
import { trendOf } from '@/lib/usage/funnel';

import { ShareBars } from './share-bars';

/**
 * "Онлайн резервации" (#371): the online share of the club's own bookings in
 * the month the "Отчети и такса" page (#372) shows, this month by default, and
 * in the five months before it. Mounted by that page's UsageCardSlot.
 *
 * The numbers come from `loadClubOnlineShare` (src/app-layer/usecases/
 * usage-report.ts), run under the club's tenant binding; that file defines the
 * share. This component only shows it: no data of its own, no directive, so it
 * renders inside the server page with the page's translations.
 *
 * The month labels are calendar months, formatted as one (noon UTC on the
 * 15th, read in UTC), so no device zone moves a month into its neighbour.
 */
export function OnlineShareCard({ data }: { data: ClubOnlineShare }) {
  const t = useTranslations('admin.onlineShare');
  const format = useFormatter();

  const current = data.months.at(-1);
  const previous = data.months.at(-2);
  const percent = (share: number) =>
    format.number(share, { style: 'percent', maximumFractionDigits: 0 });
  const monthName = (month: string, style: 'short' | 'long') =>
    format.dateTime(new Date(`${month}-15T12:00:00Z`), {
      month: style,
      ...(style === 'long' ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    });

  const trend = trendOf(current?.share, previous?.share);
  const shownMonth = current ? monthName(current.month, 'long') : '';

  const spoken = data.months
    .map((m) =>
      t('monthValue', {
        month: monthName(m.month, 'long'),
        value: m.share === null ? t('noBookingsShort') : percent(m.share),
      }),
    )
    .join(', ');

  return (
    // Flat, like the statement's own cards around it.
    <Card
      as="section"
      elevation="flat"
      aria-labelledby="online-share-title"
      className="bg-bg-default grid gap-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Heading level={2} id="online-share-title">
            {t('title')}
          </Heading>
          <Caption>{t('subtitle')}</Caption>
        </div>
        {trend && (
          <StatusBadge
            variant={trend === 'up' ? 'success' : trend === 'down' ? 'warning' : 'neutral'}
            data-trend={trend}
          >
            {t(`trend.${trend}`)}
          </StatusBadge>
        )}
      </div>

      {current && current.share !== null ? (
        <div>
          <p className="text-content-emphasis text-4xl font-semibold tabular-nums">
            {percent(current.share)}
          </p>
          <Caption>
            {t('detail', {
              online: current.online,
              total: current.online + current.desk,
              month: shownMonth,
            })}
          </Caption>
        </div>
      ) : (
        <Caption>{t('empty', { month: shownMonth })}</Caption>
      )}

      <ShareBars
        label={t('trendLabel', { values: spoken })}
        bars={data.months.map((m) => ({
          key: m.month,
          share: m.share,
          caption: monthName(m.month, 'short'),
        }))}
      />
      <Caption>{t('definition')}</Caption>
    </Card>
  );
}
