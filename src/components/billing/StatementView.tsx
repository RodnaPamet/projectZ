'use client';

import type { ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { createColumns, DataTable } from '@/components/ui/table/data-table';
import { Heading } from '@/components/ui/typography';
import type { ClubStatementDto, StatementLineDto } from '@/lib/billing/statement-dto';

/**
 * One club's fee statement for one month (#372): the totals, the club's terms,
 * the CSV download and the line items. Shared by the club's own page
 * (/t/{slug}/admin/reports) and the owner's (/platform/fees/{clubId}), so the
 * club and the owner read the same document.
 *
 * It renders what it is given and decides nothing: every number is a sum the
 * server made from the ledger, in integer cents, and only formatted here.
 *
 * `children` is the slot between the totals and the lines. The club page puts
 * its usage card there (#371).
 */
const ZONE = 'Europe/Sofia';

export function StatementView({
  statement,
  csvHref,
  children,
}: {
  statement: ClubStatementDto;
  csvHref: string;
  children?: ReactNode;
}) {
  const t = useTranslations('billing.statement');
  const format = useFormatter();
  const { totals, currency } = statement;

  const money = (cents: number) => format.number(cents / 100, { style: 'currency', currency });
  // Display only: the rate arrives as a two-decimal string and is never
  // computed with here.
  const percent = (p: string) =>
    format.number(Number(p) / 100, { style: 'percent', maximumFractionDigits: 2 });
  const startDay = format.dateTime(new Date(`${statement.feeStartsOn}T12:00:00Z`), {
    dateStyle: 'long',
    timeZone: 'UTC',
  });

  const columns = createColumns<StatementLineDto>([
    {
      id: 'when',
      header: t('column.when'),
      cell: ({ row }) =>
        format.dateTime(new Date(row.original.startsAt), {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: ZONE,
        }),
    },
    {
      id: 'court',
      // "Писта" at a karting club, "Корт / писта" at one with both (P51).
      header: t(
        statement.courtNouns === 'track'
          ? 'track.column.court'
          : statement.courtNouns === 'mixed'
            ? 'mixed.column.court'
            : 'column.court',
      ),
      cell: ({ row }) => (
        <span className="grid">
          <span className="text-content-emphasis">{row.original.courtName}</span>
          <span className="text-content-muted text-sm">{row.original.venueName}</span>
        </span>
      ),
    },
    {
      id: 'kind',
      header: t('column.kind'),
      cell: ({ row }) =>
        row.original.kind === 'CHARGE' ? (
          <StatusBadge variant="neutral">{t('kind.CHARGE')}</StatusBadge>
        ) : (
          <StatusBadge variant="warning">{t('kind.REVERSAL')}</StatusBadge>
        ),
    },
    {
      id: 'price',
      header: t('column.price'),
      cell: ({ row }) => money(row.original.priceCents),
    },
    {
      id: 'rate',
      header: t('column.rate'),
      cell: ({ row }) =>
        row.original.freePeriod ? (
          <StatusBadge variant="info">{t('freeBadge')}</StatusBadge>
        ) : (
          percent(row.original.feePercent)
        ),
    },
    {
      id: 'fee',
      header: t('column.fee'),
      cell: ({ row }) => (
        <span className="text-content-emphasis font-medium">{money(row.original.feeCents)}</span>
      ),
    },
  ]);

  return (
    <div className="gap-section grid">
      <section aria-labelledby="statement-totals" className="gap-compact grid">
        <div className="gap-compact flex flex-wrap items-center justify-between">
          <Heading level={2} id="statement-totals">
            {t('totalsHeading')}
          </Heading>
          <a
            href={csvHref}
            download
            className={buttonVariants({ variant: 'secondary' })}
            data-testid="statement-csv"
          >
            {t('downloadCsv')}
          </a>
        </div>

        <dl className="gap-compact grid grid-cols-2 lg:grid-cols-4" data-testid="statement-totals">
          <Total label={t('total.played')} value={format.number(totals.bookingsPlayed)} />
          <Total label={t('total.revenue')} value={money(totals.revenueCents)} />
          <Total label={t('total.rate')} value={percent(statement.feePercent)} />
          <Total label={t('total.fee')} value={money(totals.feeCents)} emphasis />
        </dl>

        {statement.freePeriod === 'none' ? (
          <p className="text-content-muted text-sm">{t('terms.charged', { date: startDay })}</p>
        ) : (
          <InlineNotice
            variant="info"
            title={statement.freePeriod === 'all' ? t('free.allTitle') : t('free.partTitle')}
            data-testid="statement-free-period"
          >
            {t('free.body', { date: startDay })}
          </InlineNotice>
        )}
      </section>

      {children}

      <section aria-labelledby="statement-lines" className="gap-compact grid">
        <Heading level={2} id="statement-lines">
          {t('linesHeading')}
        </Heading>

        {statement.linesTruncated && (
          <InlineNotice variant="warning">{t('linesTruncated')}</InlineNotice>
        )}

        {statement.lines.length === 0 ? (
          <EmptyState title={t('empty.title')} description={t('empty.description')} size="sm" />
        ) : (
          <div className="min-w-0">
            <DataTable<StatementLineDto>
              data={statement.lines}
              columns={columns}
              getRowId={(l) => l.id}
              mobileFallback="card"
              selectionEnabled={false}
              data-testid="statement-lines"
            />
          </div>
        )}
      </section>
    </div>
  );
}

function Total({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <Card density="compact" elevation="flat" className="bg-bg-default">
      <dt className="text-content-muted text-sm">{label}</dt>
      <dd
        className={
          emphasis
            ? 'text-content-emphasis mt-1 text-2xl font-semibold'
            : 'text-content-default mt-1 text-2xl'
        }
      >
        {value}
      </dd>
    </Card>
  );
}
