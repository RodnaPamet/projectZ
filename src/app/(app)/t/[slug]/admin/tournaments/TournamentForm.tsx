'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import type { TournamentDto } from '@/app/api/v1/_lib/tournament-dto';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption } from '@/components/ui/typography';

export const CLUB_FORMATS = [
  'SINGLE_ELIMINATION',
  'ROUND_ROBIN',
  'GROUPS_KNOCKOUT',
  'AMERICANO',
  'MEXICANO',
  'LEAGUE',
] as const;

export interface TournamentFormValue {
  name: string;
  sport: string;
  format: (typeof CLUB_FORMATS)[number];
  teamSize: 1 | 2;
  venueId: string;
  startsAt: string;
  endsAt: string | null;
  entriesCloseAt: string | null;
  drawSize: number;
  entryFeeCents: number;
  feePayment: 'AT_CLUB' | 'ONLINE';
  description: string | null;
}

/** A `datetime-local` value from an ISO instant, in the browser's (the club's) zone. */
function local(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const iso = (v: string) => (v ? new Date(v).toISOString() : null);

/**
 * A tournament's details (#579), new or changed: the name, the venue and its
 * sport, the format (decision 37), singles or doubles, the dates, the draw
 * size, the fee, paid at the club or online (#581) when the club has
 * connected its Stripe account, and a description.
 */
export function TournamentForm({
  venues,
  onlineFees,
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  venues: Array<{
    id: string;
    name: string;
    sports: string[];
    courts?: Array<{ id: string; name: string }>;
  }>;
  /** The club can take entry fees online (#581): its Stripe account is connected. */
  onlineFees: boolean;
  initial?: TournamentDto | null;
  busy: boolean;
  submitLabel: string;
  onSubmit: (value: TournamentFormValue) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('admin.tournaments.form');
  const tT = useTranslations('tournaments');
  const tSports = useTranslations('sports');
  const id = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [venueId, setVenueId] = useState(initial?.venue?.id ?? venues[0]?.id ?? '');
  const venue = venues.find((v) => v.id === venueId);
  const [sport, setSport] = useState<string>(initial?.sport ?? venue?.sports[0] ?? '');
  const [format, setFormat] = useState<TournamentFormValue['format']>(
    (initial?.format as TournamentFormValue['format']) ?? 'SINGLE_ELIMINATION',
  );
  const [teamSize, setTeamSize] = useState<1 | 2>((initial?.teamSize as 1 | 2) ?? 1);
  const [startsAt, setStartsAt] = useState(local(initial?.startsAt));
  const [endsAt, setEndsAt] = useState(local(initial?.endsAt));
  const [entriesCloseAt, setEntriesCloseAt] = useState(local(initial?.entriesCloseAt));
  const [drawSize, setDrawSize] = useState(String(initial?.drawSize ?? 8));
  const [fee, setFee] = useState(initial ? String(initial.entryFeeCents / 100) : '0');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [feePayment, setFeePayment] = useState<'AT_CLUB' | 'ONLINE'>(
    initial?.feePayment === 'ONLINE' ? 'ONLINE' : 'AT_CLUB',
  );
  const [problem, setProblem] = useState<string | null>(null);

  // Americano and Mexicano: players sign up alone; partners rotate (60).
  const rotating = format === 'AMERICANO' || format === 'MEXICANO';

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const size = Number(drawSize);
    const cents = Math.round(Number(fee.replace(',', '.')) * 100);
    if (!name.trim()) return setProblem(t('problem.name'));
    if (!venueId || !sport) return setProblem(t('problem.venue'));
    if (!startsAt) return setProblem(t('problem.startsAt'));
    if (!Number.isInteger(size) || size < 2 || size > 256) return setProblem(t('problem.drawSize'));
    if (!Number.isFinite(cents) || cents < 0) return setProblem(t('problem.fee'));
    setProblem(null);
    onSubmit({
      name: name.trim(),
      sport,
      format,
      teamSize: rotating ? 1 : teamSize,
      venueId,
      startsAt: iso(startsAt)!,
      endsAt: iso(endsAt),
      entriesCloseAt: iso(entriesCloseAt),
      drawSize: size,
      entryFeeCents: cents,
      // Online only with a fee to pay and a club that can take it (#581).
      feePayment: cents > 0 && onlineFees ? feePayment : 'AT_CLUB',
      description: description.trim() || null,
    });
  }

  const field = (key: string) => `${id}-${key}`;

  return (
    <form
      className="gap-section flex flex-col"
      onSubmit={submit}
      noValidate
      data-testid="tournament-form"
    >
      <div className="gap-tight flex flex-col">
        <Label htmlFor={field('name')}>{t('name')}</Label>
        <Input
          id={field('name')}
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          data-testid="tournament-form-name"
        />
      </div>

      {venues.length > 1 ? (
        <div className="gap-tight flex flex-col">
          <span className="text-content-default text-sm font-medium">{t('venue')}</span>
          <ToggleGroup
            options={venues.map((v) => ({ value: v.id, label: v.name }))}
            selected={venueId}
            selectAction={(v) => {
              setVenueId(v);
              const next = venues.find((x) => x.id === v);
              if (next && !next.sports.includes(sport)) setSport(next.sports[0] ?? '');
            }}
            ariaLabel={t('venue')}
            size="sm"
            className="justify-self-start"
          />
        </div>
      ) : null}

      {venue && venue.sports.length > 1 ? (
        <div className="gap-tight flex flex-col">
          <span className="text-content-default text-sm font-medium">{t('sport')}</span>
          <ToggleGroup
            options={venue.sports.map((s) => ({ value: s, label: tSports(s as never) }))}
            selected={sport}
            selectAction={setSport}
            ariaLabel={t('sport')}
            size="sm"
            className="justify-self-start"
          />
        </div>
      ) : null}

      <div className="gap-tight flex flex-col">
        <span className="text-content-default text-sm font-medium">{t('format')}</span>
        <ToggleGroup
          options={CLUB_FORMATS.map((f) => ({ value: f, label: tT(`format.${f}`) }))}
          selected={format}
          selectAction={(v) => setFormat(v as TournamentFormValue['format'])}
          ariaLabel={t('format')}
          size="sm"
          className="flex-wrap justify-self-start"
          data-testid="tournament-form-format"
        />
        <Caption>{t(`formatHint.${format}`)}</Caption>
      </div>

      <div className="gap-tight flex flex-col">
        <span className="text-content-default text-sm font-medium">{t('teamSize')}</span>
        <ToggleGroup
          options={[
            { value: '1', label: tT('singles') },
            { value: '2', label: tT('doubles'), disabled: rotating },
          ]}
          selected={rotating ? '1' : String(teamSize)}
          selectAction={(v) => setTeamSize(v === '2' ? 2 : 1)}
          ariaLabel={t('teamSize')}
          size="sm"
          className="justify-self-start"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="gap-tight flex flex-col">
          <Label htmlFor={field('startsAt')}>{t('startsAt')}</Label>
          <Input
            id={field('startsAt')}
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            data-testid="tournament-form-starts"
          />
        </div>
        <div className="gap-tight flex flex-col">
          <Label htmlFor={field('endsAt')}>{t('endsAt')}</Label>
          <Input
            id={field('endsAt')}
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </div>
        <div className="gap-tight flex flex-col">
          <Label htmlFor={field('entriesCloseAt')}>{t('entriesCloseAt')}</Label>
          <Input
            id={field('entriesCloseAt')}
            type="datetime-local"
            value={entriesCloseAt}
            onChange={(e) => setEntriesCloseAt(e.target.value)}
          />
        </div>
        <div className="gap-tight flex flex-col">
          <Label htmlFor={field('drawSize')}>
            {teamSize === 2 && !rotating ? t('drawSizePairs') : t('drawSize')}
          </Label>
          <Input
            id={field('drawSize')}
            inputMode="numeric"
            value={drawSize}
            onChange={(e) => setDrawSize(e.target.value.replace(/\D/g, ''))}
            data-testid="tournament-form-draw"
          />
        </div>
        <div className="gap-tight flex flex-col">
          <Label htmlFor={field('fee')}>{t('fee')}</Label>
          <Input
            id={field('fee')}
            inputMode="decimal"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
          />
          <Caption>{t('feeHint')}</Caption>
        </div>
      </div>

      {Number(fee.replace(',', '.')) > 0 ? (
        <div className="gap-tight flex flex-col">
          <span className="text-content-default text-sm font-medium">{t('feePayment')}</span>
          <ToggleGroup
            options={[
              { value: 'AT_CLUB', label: t('feePaymentAtClub') },
              { value: 'ONLINE', label: t('feePaymentOnline'), disabled: !onlineFees },
            ]}
            selected={onlineFees ? feePayment : 'AT_CLUB'}
            selectAction={(v) => setFeePayment(v === 'ONLINE' ? 'ONLINE' : 'AT_CLUB')}
            ariaLabel={t('feePayment')}
            size="sm"
            className="justify-self-start"
            data-testid="tournament-form-fee-payment"
          />
          <Caption>{onlineFees ? t('feePaymentHint') : t('feePaymentUnavailable')}</Caption>
        </div>
      ) : null}

      <div className="gap-tight flex flex-col">
        <Label htmlFor={field('description')}>{t('description')}</Label>
        <Textarea
          id={field('description')}
          rows={4}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      {problem ? (
        <InlineNotice variant="error" data-testid="tournament-form-problem">
          {problem}
        </InlineNotice>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={busy} disabled={busy} data-testid="tournament-form-submit">
          {submitLabel}
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}
