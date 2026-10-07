'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { MonthPicker } from '@/components/billing/MonthPicker';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { createColumns, DataTable } from '@/components/ui/table/data-table';
import { Heading } from '@/components/ui/typography';
import type { FeeOverviewRowDto } from '@/lib/billing/statement-dto';
import { isApiClientError } from '@/lib/data/errors';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { needsSkeleton, useV1SWR } from '@/lib/data/use-v1-swr';

import { StepUpForm } from '../StepUpForm';

/**
 * Every club's fee for a month (#372), and the owner's controls over it.
 *
 * ═══ READS ARE RECORDS, SO NOTHING READS ON ITS OWN ═══
 *
 * Each read is a PLATFORM_FEE_OVERVIEW_READ row with the reason stated here, as
 * the moderation queue's are: the key stays null until a reason is given, and
 * focus, reconnect and retries are off (`audited`). A new month is a new read
 * the owner asked for by picking it.
 *
 * ═══ INVOICING ═══
 *
 * Per club: its fee percentage, how much of the month the free period covers,
 * online bookings played, their revenue and the fee due, a link to the
 * statement as the club sees it, and its CSV. Both links carry the stated
 * reason, because the server audits those reads too.
 *
 * ═══ CHANGING A CLUB'S TERMS ═══
 *
 * Only with CLUB_FEE_MANAGE (`canManage`, which only HIDES the control; the
 * binding decides). The write needs a step-up from the last 15 minutes, so a
 * STEP_UP_REQUIRED answer shows the code form, and the owner saves again once
 * it is accepted. The form's own reason is the audit reason of the change.
 */

/** The platform's own minimum; the API refuses anything shorter. */
const MIN_REASON = 12;

interface Overview {
  month: string;
  clubs: FeeOverviewRowDto[];
  truncated: boolean;
}

const KNOWN_ERRORS = new Set([
  'PLATFORM_AUTHORITY_REQUIRED',
  'PLATFORM_CAPABILITY_REQUIRED',
  'REASON_REQUIRED',
  'REASON_TOO_LONG',
  'BAD_REQUEST',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'NETWORK',
  'VIEWER_CHANGED',
  'STEP_UP_REQUIRED',
  'MFA_ENROLMENT_REQUIRED',
]);

const knownCode = (e: unknown) =>
  isApiClientError(e) && KNOWN_ERRORS.has(e.code) ? e.code : 'UNKNOWN';

export function FeesBoard({
  canManage,
  months,
}: {
  canManage: boolean;
  /** `YYYY-MM` at the club, newest first; the first is this month. */
  months: readonly string[];
}) {
  const t = useTranslations('platform.fees');
  const format = useFormatter();
  const ids = useId();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [month, setMonth] = useState(months[0]!);
  const [editing, setEditing] = useState<FeeOverviewRowDto | null>(null);

  const key = submitted ? KEYS.platformFees({ month, reason: submitted }) : null;
  const overview = useV1SWR<Overview>(key, { audited: true });
  const reasonReady = reason.trim().length >= MIN_REASON;

  const money = (cents: number, currency: string) =>
    format.number(cents / 100, { style: 'currency', currency });
  const percent = (p: string) =>
    format.number(Number(p) / 100, { style: 'percent', maximumFractionDigits: 2 });
  const day = (d: string) =>
    format.dateTime(new Date(`${d}T12:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });

  const rows = overview.data?.clubs ?? [];
  // Integer cents, summed: what the owner invoices across every club.
  const dueByCurrency = new Map<string, number>();
  for (const r of rows) {
    dueByCurrency.set(r.currency, (dueByCurrency.get(r.currency) ?? 0) + r.totals.feeCents);
  }

  const columns = createColumns<FeeOverviewRowDto>([
    {
      id: 'club',
      header: t('column.club'),
      cell: ({ row }) => (
        <span className="gap-tight inline-flex flex-wrap items-center justify-end md:justify-start">
          <span className="text-content-emphasis font-medium">{row.original.club.name}</span>
          {row.original.club.status !== 'ACTIVE' && (
            <StatusBadge variant="neutral">
              {t(`status.${row.original.club.status}` as never)}
            </StatusBadge>
          )}
        </span>
      ),
    },
    {
      id: 'rate',
      header: t('column.rate'),
      cell: ({ row }) => (
        <span className="grid">
          <span>{percent(row.original.feePercent)}</span>
          <span className="text-content-muted text-sm">
            {t('chargedFrom', { date: day(row.original.feeStartsOn) })}
          </span>
        </span>
      ),
    },
    {
      id: 'free',
      header: t('column.free'),
      cell: ({ row }) =>
        row.original.freePeriod === 'none' ? (
          <StatusBadge variant="neutral">{t('free.none')}</StatusBadge>
        ) : (
          <StatusBadge variant="info">{t(`free.${row.original.freePeriod}`)}</StatusBadge>
        ),
    },
    {
      id: 'played',
      header: t('column.played'),
      cell: ({ row }) => format.number(row.original.totals.bookingsPlayed),
    },
    {
      id: 'revenue',
      header: t('column.revenue'),
      cell: ({ row }) => money(row.original.totals.revenueCents, row.original.currency),
    },
    {
      id: 'fee',
      header: t('column.fee'),
      cell: ({ row }) => (
        <span className="text-content-emphasis font-medium">
          {money(row.original.totals.feeCents, row.original.currency)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: t('column.actions'),
      cell: ({ row }) => {
        const r = row.original;
        const params = { month, reason: submitted ?? '' };
        return (
          <span className="gap-tight inline-flex flex-wrap justify-end md:justify-start">
            <Link
              href={`/platform/fees/${encodeURIComponent(r.club.id)}?${new URLSearchParams(params)}`}
              className={buttonVariants({ variant: 'ghost' })}
            >
              {t('statement')}
            </Link>
            <a
              href={V1.platformClubStatementCsv(r.club.id, params)}
              download
              className={buttonVariants({ variant: 'ghost' })}
            >
              {t('csv')}
            </a>
            {canManage && (
              <Button type="button" variant="ghost" onClick={() => setEditing(r)}>
                {t('edit')}
              </Button>
            )}
          </span>
        );
      },
    },
  ]);

  return (
    <div className="gap-section grid">
      <form
        className="border-border-subtle bg-bg-default grid gap-3 rounded-lg border p-4 sm:max-w-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (!reasonReady) return;
          const r = reason.trim();
          if (r === submitted) void overview.mutate();
          else setSubmitted(r);
        }}
      >
        <FormField label={t('reasonLabel')} description={t('reasonHint')}>
          <Input
            id={`${ids}-reason`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            autoComplete="off"
          />
        </FormField>
        <div>
          <Button type="submit" disabled={!reasonReady}>
            {submitted ? t('refresh') : t('open')}
          </Button>
        </div>
      </form>

      <MonthPicker label={t('month')} months={months} value={month} onSelect={setMonth} />

      {overview.error && (
        <InlineNotice variant="error">
          {t(`error.${knownCode(overview.error)}` as never)}
        </InlineNotice>
      )}

      {editing && canManage && (
        <TermsForm
          key={editing.club.id}
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void overview.mutate();
          }}
        />
      )}

      {submitted === null ? (
        <p className="text-content-muted text-sm">{t('needReason')}</p>
      ) : needsSkeleton(overview) ? (
        <div className="gap-compact grid" aria-busy>
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : overview.data ? (
        <section className="gap-compact grid" aria-labelledby={`${ids}-clubs`}>
          <div className="gap-compact flex flex-wrap items-baseline justify-between">
            <Heading level={2} id={`${ids}-clubs`}>
              {t('clubsHeading')}
            </Heading>
            <p className="text-content-emphasis font-medium" data-testid="fees-total-due">
              {t('totalDue', {
                amount:
                  [...dueByCurrency].map(([c, cents]) => money(cents, c)).join(' + ') ||
                  money(0, 'EUR'),
              })}
            </p>
          </div>
          {overview.data.truncated && (
            <InlineNotice variant="warning">{t('truncated')}</InlineNotice>
          )}
          {rows.length === 0 ? (
            <EmptyState title={t('empty.title')} description={t('empty.description')} size="sm" />
          ) : (
            <div className="min-w-0">
              <DataTable<FeeOverviewRowDto>
                data={rows}
                columns={columns}
                getRowId={(r) => r.club.id}
                mobileFallback="card"
                selectionEnabled={false}
                data-testid="fees-table"
              />
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

/**
 * A club's fee percentage and the first day it is charged. The percentage is
 * sent as the typed STRING ("12,5" accepted as "12.5"), so no float ever
 * carries it; the server parses and bounds it.
 */
function TermsForm({
  row,
  onClose,
  onSaved,
}: {
  row: FeeOverviewRowDto;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('platform.fees');
  const ids = useId();
  const [percentText, setPercentText] = useState(row.feePercent);
  const [startsOn, setStartsOn] = useState(row.feeStartsOn);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);

  const save = useV1Mutation<
    { feePercent: string; feeStartsOn: string; reason: string },
    { changed: boolean }
  >({
    url: () => V1.clubFeeTerms(row.club.id),
    method: 'PUT',
    body: (arg) => arg,
  });

  const percent = percentText.trim().replace(',', '.');
  const ready =
    /^\d{1,2}(\.\d{1,2})?$/.test(percent) &&
    /^\d{4}-\d{2}-\d{2}$/.test(startsOn) &&
    reason.trim().length >= MIN_REASON;

  async function submit() {
    setError(null);
    try {
      await save.trigger({ feePercent: percent, feeStartsOn: startsOn, reason: reason.trim() });
      onSaved();
    } catch (e) {
      const code = knownCode(e);
      if (code === 'STEP_UP_REQUIRED') setStepUp(true);
      setError(code);
    }
  }

  return (
    <Card density="compact" elevation="flat" className="bg-bg-default" data-testid="fee-terms-form">
      <form
        className="gap-compact grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !save.isMutating) void submit();
        }}
      >
        <Heading level={2}>{t('terms.title', { club: row.club.name })}</Heading>
        <p className="text-content-muted text-sm">{t('terms.description')}</p>

        <div className="gap-compact grid sm:grid-cols-2">
          <FormField label={t('terms.percent')} description={t('terms.percentHint')}>
            <Input
              id={`${ids}-percent`}
              value={percentText}
              onChange={(e) => setPercentText(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
            />
          </FormField>
          <FormField label={t('terms.startsOn')} description={t('terms.startsOnHint')}>
            <Input
              id={`${ids}-starts`}
              type="date"
              value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)}
            />
          </FormField>
        </div>

        <FormField label={t('terms.reason')}>
          <Input
            id={`${ids}-reason`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            autoComplete="off"
          />
        </FormField>

        {error && <InlineNotice variant="error">{t(`error.${error}` as never)}</InlineNotice>}

        <div className="gap-tight flex flex-wrap">
          <Button type="submit" disabled={!ready} loading={save.isMutating}>
            {t('terms.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('terms.cancel')}
          </Button>
        </div>
      </form>

      {stepUp && (
        <div className="mt-default">
          <StepUpForm
            onStepped={() => {
              setStepUp(false);
              setError(null);
            }}
          />
        </div>
      )}
    </Card>
  );
}
