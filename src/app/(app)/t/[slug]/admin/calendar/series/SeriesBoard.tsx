'use client';

import { useId, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import { comboProps, useRequiredChoice } from '@/app/(app)/t/[slug]/admin/pricing/choices';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldGroup } from '@/components/ui/field-group';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { isApiClientError } from '@/lib/data/errors';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { needsSkeleton, useV1SWR } from '@/lib/data/use-v1-swr';

/**
 * The club's weekly series, and moving one from a date on (#415).
 *
 * Each card is a series with a live week left: who it is for, where and when,
 * how many weeks remain and the next one. «Премести» moves every live week
 * from a date on to a new time, length or court in one go. The server checks
 * every week first and refuses the whole move with the clashing dates, which
 * this shows. A move from a later week splits the series; the list then shows
 * both halves.
 */

interface LiveSeries {
  id: string;
  resourceId: string;
  courtName: string;
  venueName: string;
  startTime: string;
  durationMinutes: number;
  customerName: string;
  linked: boolean;
  weeksLeft: number;
  nextDate: string | null;
  lastDate: string;
}

interface Clash {
  date: string;
  reason: 'taken' | 'unavailable';
}

export function SeriesBoard({
  slug,
  courts,
}: {
  slug: string;
  courts: Array<{ id: string; name: string }>;
}) {
  const t = useTranslations('admin.calendar.series');
  const format = useFormatter();
  const list = useV1SWR<{ items: LiveSeries[] }>(KEYS.clubSeries(slug));
  const [moving, setMoving] = useState<LiveSeries | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const weekday = (date: string) =>
    format.dateTime(new Date(`${date}T12:00:00Z`), { weekday: 'long', timeZone: 'UTC' });
  const day = (date: string) =>
    format.dateTime(new Date(`${date}T12:00:00Z`), {
      day: 'numeric',
      month: 'long',
      timeZone: 'UTC',
    });

  if (needsSkeleton(list)) {
    return (
      <div className="gap-compact grid">
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
      </div>
    );
  }
  if (list.error && !list.data) {
    return <InlineNotice variant="error">{t('error.load')}</InlineNotice>;
  }
  const items = list.data?.items ?? [];
  if (items.length === 0) return <EmptyState title={t('empty')} />;

  return (
    <div className="gap-section grid">
      {done && (
        <InlineNotice variant="success" data-testid="series-moved">
          {done}
        </InlineNotice>
      )}

      {moving && (
        <MoveForm
          key={moving.id}
          slug={slug}
          series={moving}
          courts={courts}
          onClose={() => setMoving(null)}
          onMoved={(moved) => {
            setDone(t('moved', { count: moved }));
            setMoving(null);
            void list.mutate();
          }}
        />
      )}

      <ul className="gap-compact grid" data-testid="series-list">
        {items.map((s) => (
          <li key={s.id}>
            <Card density="compact" elevation="flat" className="bg-bg-default">
              <div className="gap-compact flex flex-wrap items-start justify-between">
                <div className="min-w-0">
                  <p className="text-content-emphasis font-medium">
                    {s.customerName}
                    {s.linked && (
                      <StatusBadge variant="info" size="sm" className="ms-2">
                        {t('linked')}
                      </StatusBadge>
                    )}
                  </p>
                  <p className="text-content-default text-sm">
                    {s.nextDate ? weekday(s.nextDate) : ''} {s.startTime} · {s.durationMinutes}{' '}
                    {t('minutes')} · {s.venueName}, {s.courtName}
                  </p>
                  <p className="text-content-muted text-sm">
                    {t('left', { count: s.weeksLeft })}
                    {s.nextDate ? ` · ${t('next', { date: day(s.nextDate) })}` : ''}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setDone(null);
                    setMoving(s);
                  }}
                  data-testid="series-move"
                >
                  {t('move')}
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MoveForm({
  slug,
  series,
  courts,
  onClose,
  onMoved,
}: {
  slug: string;
  series: LiveSeries;
  courts: Array<{ id: string; name: string }>;
  onClose: () => void;
  onMoved: (moved: number) => void;
}) {
  const t = useTranslations('admin.calendar.series');
  const ids = useId();
  const [fromDate, setFromDate] = useState(series.nextDate ?? '');
  const [startTime, setStartTime] = useState(series.startTime);
  const [duration, setDuration] = useState(String(series.durationMinutes));
  const courtOptions = useMemo<ComboboxOption[]>(
    () => courts.map((c) => ({ value: c.id, label: c.name })),
    [courts],
  );
  const court = useRequiredChoice(courtOptions, series.resourceId);
  const [clashes, setClashes] = useState<Clash[]>([]);
  const [error, setError] = useState<string | null>(null);

  const move = useV1Mutation<
    { fromDate: string; startTime: string; durationMinutes: number; resourceId: string },
    { moved: number }
  >({ url: () => V1.moveSeries(slug, series.id), method: 'PATCH', body: (arg) => arg });

  const minutes = Number(duration);
  const ready =
    /^\d{4}-\d{2}-\d{2}$/.test(fromDate) &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) &&
    Number.isInteger(minutes) &&
    minutes >= 15;

  async function submit() {
    setError(null);
    setClashes([]);
    try {
      const answer = await move.trigger({
        fromDate,
        startTime,
        durationMinutes: minutes,
        resourceId: court.value,
      });
      onMoved(answer?.moved ?? 0);
    } catch (e) {
      if (isApiClientError(e) && e.code === 'SERIES_CLASH') {
        const details = e.details as { clashes?: Clash[] } | undefined;
        setClashes(details?.clashes ?? []);
        setError('SERIES_CLASH');
      } else {
        setError(isApiClientError(e) ? e.code : 'UNKNOWN');
      }
    }
  }

  return (
    <Card
      density="compact"
      elevation="flat"
      className="bg-bg-default"
      data-testid="series-move-form"
    >
      <form
        className="gap-compact grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !move.isMutating) void submit();
        }}
      >
        <Heading level={2}>{t('form.title', { name: series.customerName })}</Heading>
        <p className="text-content-muted text-sm">{t('form.description')}</p>

        <FieldGroup columns={2}>
          <FormField label={t('form.from')}>
            <Input
              id={`${ids}-from`}
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </FormField>
          <FormField label={t('form.court')}>
            <Combobox
              id={`${ids}-court`}
              options={courtOptions}
              selected={court.selected}
              setSelected={court.setSelected}
              {...comboProps(t('form.court'), court.selected)}
            />
          </FormField>
          <FormField label={t('form.time')}>
            <Input
              id={`${ids}-time`}
              type="time"
              step={900}
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </FormField>
          <FormField label={t('form.duration')}>
            <Input
              id={`${ids}-duration`}
              type="number"
              inputMode="numeric"
              min={15}
              step={15}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </FormField>
        </FieldGroup>

        {error === 'SERIES_CLASH' ? (
          <InlineNotice variant="error" data-testid="series-move-clashes">
            {t('error.clash')}{' '}
            {clashes.map((c) => `${c.date} (${t(`error.reason.${c.reason}`)})`).join(', ')}
          </InlineNotice>
        ) : error ? (
          <InlineNotice variant="error">{t('error.move')}</InlineNotice>
        ) : null}

        <div className="gap-tight flex flex-wrap">
          <Button type="submit" disabled={!ready} loading={move.isMutating}>
            {t('form.submit')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('form.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
