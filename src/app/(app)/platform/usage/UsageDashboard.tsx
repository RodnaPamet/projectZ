'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { CardListSkeleton } from '@/components/loading/shapes';
import { MeterBar, ShareBars } from '@/components/reports/share-bars';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/ui/status-badge';
import { createColumns, DataTable } from '@/components/ui/table/data-table';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption, Heading } from '@/components/ui/typography';
import { isApiClientError } from '@/lib/data/errors';
import { KEYS } from '@/lib/data/keys';
import { needsSkeleton, useV1SWR } from '@/lib/data/use-v1-swr';
import type { UsageEventName } from '@/lib/usage/events';
import { type FunnelCounts, funnelSteps, type Trend } from '@/lib/usage/funnel';

/**
 * The pilot's numbers on `/platform/usage` (#371).
 *
 * ═══ EVERY READ IS A RECORD, SO NOTHING READS ON ITS OWN ═══
 *
 * `GET /api/v1/platform/usage` writes a PLATFORM_USAGE_READ audit row with the
 * reason the reader gave, so this is the moderation queue's shape: the key is
 * null until a reason is submitted, and the read is `audited` (no focus,
 * reconnect or retry reads). A read happens on "Show", "Refresh", and a change
 * of the funnel's range — each one a person asking.
 *
 * Everything shown is a count: booking totals per club, and the anonymous
 * daily funnel counters. Nothing here names a person.
 */

const MIN_REASON = 12;
const DAY_OPTIONS = ['7', '30', '90'] as const;

interface Counts {
  online: number;
  desk: number;
  share: number | null;
}

interface ClubRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  startedAt: string;
  weeksSinceStart: number;
  active: boolean;
  lastBookingAt: string | null;
  thisMonth: Counts;
  lastMonth: Counts;
  trend: Trend | null;
  weeks: Array<Counts & { week: string }>;
}

interface VenueRow {
  venueId: string;
  venueName: string | null;
  clubId: string | null;
  clubName: string | null;
  counts: FunnelCounts;
}

export interface UsageReport {
  timeZone: string;
  month: string;
  previousMonth: string;
  clubs: ClubRow[];
  funnel: { days: number; from: string; to: string; site: FunnelCounts; venues: VenueRow[] };
}

const KNOWN_ERRORS = new Set([
  'PLATFORM_AUTHORITY_REQUIRED',
  'PLATFORM_CAPABILITY_REQUIRED',
  'REASON_REQUIRED',
  'REASON_TOO_LONG',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'NETWORK',
  'VIEWER_CHANGED',
]);

const knownCode = (e: unknown) =>
  isApiClientError(e) && KNOWN_ERRORS.has(e.code) ? e.code : 'UNKNOWN';

/** The venue table's steps: a venue's own funnel starts at its page. */
const VENUE_STEPS: readonly UsageEventName[] = [
  'VENUE_VIEW',
  'SLOT_PICKED',
  'SHEET_OPENED',
  'BOOKING_CREATED',
];

export function UsageDashboard() {
  const t = useTranslations('platform.usage');
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [days, setDays] = useState<(typeof DAY_OPTIONS)[number]>('30');

  const key = submitted ? KEYS.platformUsage({ reason: submitted, days: Number(days) }) : null;
  const report = useV1SWR<UsageReport>(key, { audited: true });
  const { data, error, isValidating, mutate } = report;

  const reasonReady = reason.trim().length >= MIN_REASON;

  function open() {
    const r = reason.trim();
    if (r !== submitted) setSubmitted(r);
    // The same reason again is "Refresh": one read.
    else void mutate();
  }

  return (
    <div className="grid gap-6">
      <form
        className="grid gap-1.5 sm:max-w-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (reasonReady) open();
        }}
      >
        <Label htmlFor="usage-reason">{t('reason.label')}</Label>
        <Input
          id="usage-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          minLength={MIN_REASON}
          maxLength={500}
          autoComplete="off"
        />
        <p className="text-content-muted text-sm">{t('reason.hint', { min: MIN_REASON })}</p>
        <div>
          <Button type="submit" disabled={!reasonReady || isValidating}>
            {data === undefined ? t('open') : t('refresh')}
          </Button>
        </div>
      </form>

      {error && (
        <InlineNotice variant="error">{t(`error.${knownCode(error)}` as never)}</InlineNotice>
      )}

      {submitted && needsSkeleton(report) && <CardListSkeleton rows={2} lines={3} />}

      {data && (
        <>
          <ClubsSection report={data} />
          <FunnelSection
            report={data}
            days={days}
            onDays={(d) => setDays(d as (typeof DAY_OPTIONS)[number])}
          />
        </>
      )}
    </div>
  );
}

function usePercent() {
  const format = useFormatter();
  return (share: number | null) =>
    share === null ? '—' : format.number(share, { style: 'percent', maximumFractionDigits: 0 });
}

const TREND_VARIANT = { up: 'success', down: 'warning', flat: 'neutral' } as const;

export function ClubsSection({ report }: { report: UsageReport }) {
  const t = useTranslations('platform.usage');
  const format = useFormatter();
  const percent = usePercent();
  const monthName = (month: string) =>
    format.dateTime(new Date(`${month}-15T12:00:00Z`), { month: 'long', timeZone: 'UTC' });
  const weekName = (day: string) =>
    format.dateTime(new Date(`${day}T12:00:00Z`), {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    });

  const columns = createColumns<ClubRow>([
    {
      id: 'club',
      header: t('clubs.club'),
      cell: ({ row }) => (
        <span className="grid">
          <span className="text-content-emphasis font-medium">{row.original.name}</span>
          <Caption>{row.original.slug}</Caption>
        </span>
      ),
    },
    {
      id: 'thisMonth',
      header: t('clubs.thisMonth', { month: monthName(report.month) }),
      cell: ({ row }) => {
        const m = row.original.thisMonth;
        return (
          <span className="grid tabular-nums">
            <span className="text-content-emphasis font-medium">{percent(m.share)}</span>
            <Caption>{t('clubs.ofTotal', { online: m.online, total: m.online + m.desk })}</Caption>
          </span>
        );
      },
    },
    {
      id: 'lastMonth',
      header: t('clubs.lastMonth', { month: monthName(report.previousMonth) }),
      cell: ({ row }) => (
        <span className="tabular-nums">{percent(row.original.lastMonth.share)}</span>
      ),
    },
    {
      id: 'trend',
      header: t('clubs.trend'),
      cell: ({ row }) =>
        row.original.trend ? (
          <StatusBadge variant={TREND_VARIANT[row.original.trend]} data-trend={row.original.trend}>
            {t(`trend.${row.original.trend}`)}
          </StatusBadge>
        ) : (
          <Caption>{t('trend.none')}</Caption>
        ),
    },
    {
      id: 'bookings',
      header: t('clubs.bookings'),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.thisMonth.online + row.original.thisMonth.desk}
        </span>
      ),
    },
    {
      id: 'weeks',
      header: t('clubs.weeks'),
      cell: ({ row }) => (
        <ShareBars
          size="sm"
          className="w-28"
          label={t('clubs.weeksLabel', {
            values: row.original.weeks
              .map((w) => `${weekName(w.week)} ${percent(w.share)}`)
              .join(', '),
          })}
          bars={row.original.weeks.map((w) => ({ key: w.week, share: w.share }))}
        />
      ),
    },
    {
      id: 'age',
      header: t('clubs.age'),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {t('clubs.ageValue', { weeks: row.original.weeksSinceStart })}
        </span>
      ),
    },
    {
      id: 'active',
      header: t('clubs.status'),
      cell: ({ row }) => (
        <StatusBadge
          variant={row.original.active ? 'success' : 'warning'}
          data-club-active={row.original.active}
        >
          {row.original.active ? t('clubs.active') : t('clubs.inactive')}
        </StatusBadge>
      ),
    },
  ]);

  return (
    <section aria-labelledby="usage-clubs" className="gap-compact grid">
      <Heading level={2} id="usage-clubs">
        {t('clubs.title')}
      </Heading>
      <Caption>{t('clubs.definition')}</Caption>
      {report.clubs.length === 0 ? (
        <EmptyState title={t('clubs.emptyTitle')} description={t('clubs.empty')} size="sm" />
      ) : (
        <div data-perf-ready className="min-w-0">
          <DataTable<ClubRow>
            data={report.clubs}
            columns={columns}
            getRowId={(c) => c.id}
            mobileFallback="card"
            selectionEnabled={false}
            data-testid="usage-clubs-table"
          />
        </div>
      )}
    </section>
  );
}

export function FunnelSection({
  report,
  days,
  onDays,
}: {
  report: UsageReport;
  days: string;
  onDays: (days: string) => void;
}) {
  const t = useTranslations('platform.usage');
  const percent = usePercent();
  const steps = funnelSteps(report.funnel.site);
  const top = Math.max(1, ...steps.map((s) => s.count));

  const columns = createColumns<VenueRow>([
    {
      id: 'venue',
      header: t('funnel.venue'),
      cell: ({ row }) => (
        <span className="grid">
          <span className="text-content-emphasis font-medium">
            {row.original.venueName ?? t('funnel.unknownVenue')}
          </span>
          {row.original.clubName && <Caption>{row.original.clubName}</Caption>}
        </span>
      ),
    },
    ...VENUE_STEPS.map((event) => ({
      id: event,
      header: t(`event.${event}`),
      cell: ({ row }: { row: { original: VenueRow } }) => {
        const s = funnelSteps(row.original.counts, VENUE_STEPS).find((x) => x.event === event)!;
        return (
          <span className="grid tabular-nums">
            <span>{s.count}</span>
            {s.fromPrevious !== null && <Caption>{percent(s.fromPrevious)}</Caption>}
          </span>
        );
      },
    })),
    {
      id: 'conversion',
      header: t('funnel.conversion'),
      cell: ({ row }) => {
        const c = row.original.counts;
        return (
          <span className="tabular-nums">
            {percent(c.VENUE_VIEW > 0 ? c.BOOKING_CREATED / c.VENUE_VIEW : null)}
          </span>
        );
      },
    },
    {
      id: 'slotsViews',
      header: t('event.SLOTS_VIEW'),
      cell: ({ row }) => <span className="tabular-nums">{row.original.counts.SLOTS_VIEW}</span>,
    },
  ]);

  return (
    <section aria-labelledby="usage-funnel" className="gap-compact grid">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Heading level={2} id="usage-funnel">
          {t('funnel.title')}
        </Heading>
        <ToggleGroup
          size="sm"
          ariaLabel={t('funnel.range')}
          options={DAY_OPTIONS.map((d) => ({ value: d, label: t('funnel.days', { days: d }) }))}
          selected={days}
          selectAction={onDays}
        />
      </div>
      <Caption>{t('funnel.period', { from: report.funnel.from, to: report.funnel.to })}</Caption>

      <Card density="compact" data-testid="usage-site-funnel">
        <ol className="grid gap-3">
          {steps.map((s) => (
            <li key={s.event} className="grid gap-1">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-content-default">{t(`event.${s.event}`)}</span>
                <span className="text-content-emphasis tabular-nums">
                  {s.count}
                  {s.fromPrevious !== null && (
                    <span className="text-content-muted">
                      {' · '}
                      {t('funnel.fromPrevious', { percent: percent(s.fromPrevious) })}
                    </span>
                  )}
                </span>
              </div>
              <MeterBar value={s.count} max={top} />
            </li>
          ))}
        </ol>
      </Card>
      <Caption>{t('funnel.definition')}</Caption>

      <Heading level={3}>{t('funnel.byVenue')}</Heading>
      {report.funnel.venues.length === 0 ? (
        <EmptyState
          title={t('funnel.emptyTitle')}
          description={t('funnel.empty')}
          size="sm"
          variant="no-results"
        />
      ) : (
        <div className="min-w-0">
          <DataTable<VenueRow>
            data={report.funnel.venues}
            columns={columns}
            getRowId={(v) => v.venueId}
            mobileFallback="card"
            selectionEnabled={false}
            data-testid="usage-venues-table"
          />
        </div>
      )}
    </section>
  );
}
