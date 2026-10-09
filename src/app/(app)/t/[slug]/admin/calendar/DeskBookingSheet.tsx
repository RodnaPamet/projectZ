'use client';

import { useId, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { BookingSeriesDto, DeskBookingDto, DeskPreviewDto } from '@/app/api/v1/_lib/desk-dto';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FieldGroup } from '@/components/ui/field-group';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { StatusBadge } from '@/components/ui/status-badge';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption } from '@/components/ui/typography';
import type { ApiClientError } from '@/lib/data/errors';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';
import { combineNouns } from '@/lib/sports/resource-kinds';

import type { GridCourt } from './DayGrid';
import { customerBody, DeskCustomerFields, type DeskCustomerValue } from './DeskCustomerFields';

/**
 * "+ Резервация" in the diary, and a tap on a free hour (#364): staff book a
 * court for a customer by name and phone, optionally linked to one of the
 * club's players, once or every week.
 *
 * ═══ THE SERVER DECIDES, THE SHEET SHOWS ═══
 *
 * The quote and the clashes come from `GET …/desk-bookings/preview`, keyed on
 * the form, so the price shown is the price the server would charge and the
 * weeks marked taken are the weeks it would refuse. Saving a series skips the
 * weeks the preview showed as not free — or the desk cancels and picks
 * another time. If more weeks were taken in between, the server answers
 * SERIES_CLASH, the preview is re-read, and the desk sees them before saving
 * again. Nothing here does time-zone arithmetic: the date and time are the
 * club's wall clock, sent as typed.
 *
 * Loaded on demand (`next/dynamic` in DayGrid), so the diary's first load does
 * not carry the form.
 */

export interface DeskDraft {
  courtId: string;
  date: string;
  time: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Shift an ISO day by whole days, through UTC. */
function shiftDay(isoDay: string, days: number): string {
  const [y, m, d] = isoDay.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** The codes the sheet has words for; anything else is `generic`. */
const KNOWN_ERRORS = new Set([
  'SLOT_TAKEN',
  'SLOT_NOT_BOOKABLE',
  'PLAYER_NOT_FOUND',
  'SERIES_CLASH',
  'INVALID_SERIES',
  'BAD_REQUEST',
]);

export default function DeskBookingSheet({
  slug,
  courts,
  draft,
  onClose,
  onSaved,
}: {
  slug: string;
  courts: GridCourt[];
  /** What was tapped: the court, the day and the hour to start from. */
  draft: DeskDraft;
  onClose: () => void;
  /** Saved: the club-local date of the (first) booking. */
  onSaved: (date: string) => void;
}) {
  const t = useTranslations('admin.calendar.desk.create');
  const tc = useTranslations('common');
  const format = useFormatter();
  const ids = useId();
  const bookable = courts.filter((c) => c.bookable);

  const [courtId, setCourtId] = useState(draft.courtId);
  const court = bookable.find((c) => c.id === courtId) ?? bookable[0];
  // P51, #454: the picker is "Писта" at a karting club, "Корт или игрище" at
  // one with courts and pitches; what is said about the chosen one follows its
  // own noun.
  const pickerNouns = combineNouns(bookable.map((c) => c.noun));
  const courtLabel = t(pickerNouns === 'court' ? 'court' : `${pickerNouns}.court`);
  const noun = court?.noun ?? 'court';
  const durations = court?.durations ?? [60];
  const [chosenDuration, setDuration] = useState<number | null>(null);
  const duration =
    chosenDuration && durations.includes(chosenDuration) ? chosenDuration : durations[0]!;

  const [date, setDate] = useState(draft.date);
  const [time, setTime] = useState(draft.time);
  const [customer, setCustomer] = useState<DeskCustomerValue>({
    name: '',
    phone: '',
    linked: null,
  });
  const [priceText, setPriceText] = useState('');
  const [notes, setNotes] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [mode, setMode] = useState<'weeks' | 'until'>('weeks');
  const [weeksText, setWeeksText] = useState('4');
  const [until, setUntil] = useState(shiftDay(draft.date, 21));
  const [error, setError] = useState<string | null>(null);

  const weeks = Number.parseInt(weeksText, 10);
  const repeatValid = !repeat
    ? true
    : mode === 'weeks'
      ? Number.isInteger(weeks) && weeks >= 1 && weeks <= 52
      : ISO_DAY.test(until) && until >= date;
  const slotValid = !!court && ISO_DAY.test(date) && HH_MM.test(time);

  // ── The server's quote and clashes, keyed on the form ──────────────
  const previewKey =
    slotValid && repeatValid
      ? KEYS.deskPreview(slug, {
          resourceId: court!.id,
          date,
          startTime: time,
          durationMinutes: duration,
          ...(repeat ? (mode === 'weeks' ? { weeks } : { until }) : {}),
        })
      : null;
  const preview = useV1SWR<DeskPreviewDto>(previewKey, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  });
  const occurrences = previewKey ? (preview.data?.occurrences ?? []) : [];
  const clashes = occurrences.filter((o) => o.status !== 'free');
  const toBook = occurrences.length - clashes.length;
  const quote = occurrences.find((o) => o.quotedCents !== null)?.quotedCents ?? null;
  const money = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: 'EUR' });

  // ── Saving ────────────────────────────────────────────────────────
  const createOne = useV1Mutation<Record<string, unknown>, DeskBookingDto>({
    url: () => V1.createDeskBooking(slug),
    body: (arg) => arg,
  });
  const createSeries = useV1Mutation<Record<string, unknown>, BookingSeriesDto>({
    url: () => V1.createSeries(slug),
    body: (arg) => arg,
  });
  const saving = createOne.isMutating || createSeries.isMutating;

  const priceCents = (() => {
    const text = priceText.trim().replace(',', '.');
    if (text === '') return null;
    const n = Number(text);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : Number.NaN;
  })();

  const who = customerBody(customer);
  const canSave =
    slotValid &&
    repeatValid &&
    who !== null &&
    !Number.isNaN(priceCents) &&
    !!preview.data &&
    !preview.isValidating &&
    toBook > 0 &&
    (repeat || clashes.length === 0);

  const save = async () => {
    if (!who || !court) return;
    setError(null);
    const body = {
      resourceId: court.id,
      date,
      startTime: time,
      durationMinutes: duration,
      customer: who,
      priceCents,
      notes: notes.trim() === '' ? null : notes.trim(),
    };
    try {
      if (repeat) {
        await createSeries.trigger({
          ...body,
          repeat: mode === 'weeks' ? { weeks } : { until },
          skipDates: clashes.map((c) => c.date),
        });
      } else {
        await createOne.trigger(body);
      }
      onSaved(occurrences.find((o) => o.status === 'free')?.date ?? date);
    } catch (err) {
      const code = (err as ApiClientError).code;
      setError(KNOWN_ERRORS.has(code) ? code : 'generic');
      // The weeks moved under us: show the desk what is taken now.
      if (code === 'SERIES_CLASH' || code === 'SLOT_TAKEN') void preview.mutate();
    }
  };

  const courtOptions: ComboboxOption[] = bookable.map((c) => ({ value: c.id, label: c.name }));
  const selectedCourt = courtOptions.find((o) => o.value === court?.id) ?? null;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('title')}
      size="md"
    >
      <Sheet.Header title={t('title')} description={t('description')} />
      <Sheet.Body className="gap-default grid content-start" data-desk-sheet>
        <FormField label={courtLabel}>
          <Combobox
            id={`${ids}-court`}
            options={courtOptions}
            selected={selectedCourt}
            setSelected={(o) => {
              if (o) setCourtId(o.value);
            }}
            matchTriggerWidth
            caret
            buttonProps={{
              className: 'w-full',
              'aria-label': selectedCourt ? `${courtLabel}, ${selectedCourt.label}` : courtLabel,
            }}
          />
        </FormField>

        <FieldGroup columns={2}>
          <FormField label={t('date')}>
            <Input
              id={`${ids}-date`}
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </FormField>
          <FormField label={t('time')}>
            <Input
              id={`${ids}-time`}
              type="time"
              value={time}
              step={(court?.slotStepMinutes ?? 60) * 60}
              onChange={(e) => setTime(e.target.value)}
              required
              data-desk-time
            />
          </FormField>
        </FieldGroup>

        {durations.length > 1 && (
          <div className="gap-tight grid">
            <Label>{t('duration')}</Label>
            <ToggleGroup
              ariaLabel={t('duration')}
              className="w-fit max-w-full flex-wrap"
              options={durations.map((m) => ({
                value: String(m),
                label: t('minutes', { count: m }),
              }))}
              selected={String(duration)}
              selectAction={(v) => setDuration(Number(v))}
            />
          </div>
        )}

        <DeskCustomerFields slug={slug} value={customer} onChange={setCustomer} />

        <FormField
          label={t('price')}
          description={quote !== null ? t('priceHint', { quote: money(quote) }) : undefined}
        >
          <Input
            id={`${ids}-price`}
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={priceText}
            placeholder={quote !== null ? (quote / 100).toFixed(2) : undefined}
            onChange={(e) => setPriceText(e.target.value)}
          />
        </FormField>

        <FormField label={t('notes')} description={t('notesHint')}>
          <Textarea
            id={`${ids}-notes`}
            value={notes}
            maxLength={500}
            rows={2}
            onChange={(e) => setNotes(e.target.value)}
          />
        </FormField>

        {/* The whole row is the target, as on the courts form: 44 px tall. */}
        <div className="gap-tight flex min-h-11 items-center">
          <Switch id={`${ids}-repeat`} checked={repeat} onCheckedChange={setRepeat} />
          <Label htmlFor={`${ids}-repeat`} className="cursor-pointer py-3">
            {t('repeat')}
          </Label>
        </div>

        {repeat && (
          <div className="gap-default grid" data-desk-repeat>
            <div className="gap-tight grid">
              <Label>{t('repeatMode')}</Label>
              <ToggleGroup
                ariaLabel={t('repeatMode')}
                className="w-fit max-w-full flex-wrap"
                options={[
                  { value: 'weeks', label: t('byWeeks') },
                  { value: 'until', label: t('byDate') },
                ]}
                selected={mode}
                selectAction={(v) => setMode(v === 'until' ? 'until' : 'weeks')}
              />
            </div>
            {mode === 'weeks' ? (
              <FormField label={t('weeks')}>
                <Input
                  id={`${ids}-weeks`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={52}
                  value={weeksText}
                  onChange={(e) => setWeeksText(e.target.value)}
                  data-desk-weeks-input
                />
              </FormField>
            ) : (
              <FormField label={t('until')}>
                <Input
                  id={`${ids}-until`}
                  type="date"
                  min={date}
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                />
              </FormField>
            )}
          </div>
        )}

        {previewKey && !preview.data && preview.isLoading && <Caption>{t('checking')}</Caption>}

        {!repeat && occurrences[0]?.status === 'unavailable' && (
          <InlineNotice variant="warning">
            {t(noun === 'court' ? 'unavailable' : `${noun}.unavailable`)}
          </InlineNotice>
        )}
        {!repeat && occurrences[0]?.status === 'taken' && (
          <InlineNotice variant="warning">{t('error.SLOT_TAKEN')}</InlineNotice>
        )}

        {repeat && occurrences.length > 0 && (
          <div className="gap-tight grid" data-desk-weeks>
            {clashes.length === 0 ? (
              <InlineNotice variant="success">
                {t('allFree', { count: occurrences.length })}
              </InlineNotice>
            ) : (
              <InlineNotice variant="warning" title={t('clashTitle', { count: clashes.length })}>
                {t('clashBody')}
              </InlineNotice>
            )}
            <ul className="gap-tight flex flex-wrap" aria-label={t('repeat')}>
              {occurrences.map((o) => (
                <li key={o.date} data-desk-week={o.date} data-desk-week-status={o.status}>
                  <StatusBadge
                    variant={o.status === 'free' ? 'success' : 'warning'}
                    icon={null}
                    className={o.status === 'free' ? undefined : 'line-through'}
                  >
                    {format.dateTime(new Date(`${o.date}T12:00:00Z`), {
                      day: 'numeric',
                      month: 'short',
                      timeZone: 'UTC',
                    })}
                    {o.status === 'taken' && ` · ${t('status.taken')}`}
                    {o.status === 'unavailable' && ` · ${t('status.unavailable')}`}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <InlineNotice variant="error" onDismiss={() => setError(null)}>
            {/* The one refusal that names the court says "Пистата" for a track. */}
            {t(
              (noun !== 'court' && error === 'SLOT_NOT_BOOKABLE'
                ? `${noun}.error.SLOT_NOT_BOOKABLE`
                : `error.${error}`) as never,
            )}
          </InlineNotice>
        )}
      </Sheet.Body>
      <Sheet.Actions>
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
          {tc('cancel')}
        </Button>
        <Button type="button" onClick={save} disabled={!canSave} loading={saving} data-desk-save>
          {repeat
            ? clashes.length > 0
              ? t('submitSkip', { count: clashes.length })
              : t('submitSeries', { count: toBook })
            : t('submit')}
        </Button>
      </Sheet.Actions>
    </Sheet>
  );
}
