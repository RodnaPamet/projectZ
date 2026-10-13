'use client';

import dynamic from 'next/dynamic';
import { useFormatter, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import type { toMyCoachLinks } from '@/app/api/v1/_lib/coach-dto';
import { PROFILE_ROW, ProfileSection } from '@/components/profile/ProfileSection';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption } from '@/components/ui/typography';
import {
  COACH_CUTOFF_MAX_HOURS,
  COACH_HOURS_PER_DAY_MAX,
  COACH_RATE_MAX_CENTS,
  COACH_TIME_OFF_NOTE_MAX,
} from '@/lib/coaches/teaching';
import { isApiClientError } from '@/lib/data/errors';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWRInfinite } from '@/lib/data/use-v1-swr';

// Loaded when a coach is about to stop teaching somewhere.
const ConfirmDialog = dynamic(() =>
  import('@/components/ui/confirm-dialog').then((m) => m.ConfirmDialog),
);

/** The coach's links as `GET /api/v1/me/coach-links` answers. */
export type CoachLinksView = ReturnType<typeof toMyCoachLinks>;
type Link = CoachLinksView['links'][number];
export interface TimeOffItem {
  id: string;
  startDate: string;
  endDate: string;
  note: string | null;
}

const KNOWN = new Set([
  'COACH_NOT_APPROVED',
  'COACH_LINK_EXISTS',
  'COACH_LINK_STATE',
  'COACH_LINK_NOT_FOUND',
  'COACH_SUSPENDED_AT_CLUB',
  'VENUE_NOT_FOUND',
  'COACH_TIME_OFF_LIMIT',
  'RATE_LIMITED',
  'NETWORK',
]);
const FIELDS = new Set([
  'hourlyRateCents',
  'groupRateCents',
  'lessonMinutes',
  'cancelCutoffHours',
  'hours',
  'startDate',
  'endDate',
  'note',
]);

/** Which sentence under `coachVenues.error` says what went wrong. */
export function venuesErrorKey(e: unknown): string {
  if (!isApiClientError(e)) return 'UNKNOWN';
  if (e.code === 'VALIDATION_ERROR') {
    const field = (e.details as { field?: unknown } | undefined)?.field;
    return typeof field === 'string' && FIELDS.has(field) ? field : 'UNKNOWN';
  }
  return KNOWN.has(e.code) ? e.code : 'UNKNOWN';
}

/** `40`, `40,5` or `40.50` → 4000, 4050; anything else, or out of range, null. */
export function parseRate(raw: string): number | null {
  const text = raw.trim().replace(',', '.');
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return cents <= COACH_RATE_MAX_CENTS ? cents : null;
}

/** 4050 → `40.5`, as the field shows it. */
export const rateText = (cents: number | null) => (cents === null ? '' : String(cents / 100));

/** Monday first, as the week is read here; 0 is Sunday in the data. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;
const TIME_ZONE = 'Europe/Sofia';

const STATUS_TONE: Record<Link['status'], 'success' | 'warning' | 'neutral'> = {
  ACTIVE: 'success',
  REQUESTED: 'warning',
  INVITED: 'warning',
  DECLINED: 'neutral',
  ENDED: 'neutral',
};

/**
 * «Клубове» and «Почивни дни» on the coach's own page (#546; owner decisions
 * 2, 4, 5, 6, 9, 14): where the coach teaches or asked to, what they charge
 * and when they work at each venue, and the days they teach nowhere.
 *
 * Every write answers with the whole list, which replaces what is on screen,
 * so the page never guesses what a write did. Rates and hours are the
 * coach's to set; whether they teach at a venue at all is the club's, which
 * answers a request on its own page.
 */
export function CoachVenuesSection({
  seed,
  timeOffSeed,
}: {
  seed: CoachLinksView;
  timeOffSeed: TimeOffItem[];
}) {
  const t = useTranslations('coachVenues');
  const format = useFormatter();
  const [view, setView] = useState(seed);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [ending, setEnding] = useState<Link | null>(null);
  const [confirming, setConfirming] = useState(false);

  const ask = useV1Mutation<string, CoachLinksView>({
    url: () => V1.coachLinks(),
    body: (venueId) => ({ venueId }),
  });
  const end = useV1Mutation<string, CoachLinksView>({
    url: (id) => V1.coachLink(id),
    method: 'DELETE',
  });

  async function run(what: () => Promise<CoachLinksView | undefined>): Promise<boolean> {
    setError(null);
    try {
      const next = await what();
      if (next) setView(next);
      return true;
    } catch (e) {
      setError(venuesErrorKey(e));
      return false;
    }
  }

  // What is going on now first; what is over, after.
  const live = view.links.filter((l) => l.status !== 'DECLINED' && l.status !== 'ENDED');
  const past = view.links.filter((l) => l.status === 'DECLINED' || l.status === 'ENDED');
  const busy = ask.isMutating || end.isMutating;
  const editingLink = view.links.find((l) => l.id === editing) ?? null;
  const money = (cents: number, currency: string) =>
    format.number(cents / 100, { style: 'currency', currency });

  return (
    <>
      <ProfileSection title={t('title')} testId="coach-venues">
        {view.links.length === 0 ? (
          <div className={PROFILE_ROW}>
            <span className="text-content-muted text-sm">
              {view.approved ? t('none') : t('needsApproval')}
            </span>
          </div>
        ) : null}
        {[...live, ...past].map((l) => (
          <div
            key={l.id}
            className="gap-tight grid px-4 py-3"
            data-testid="coach-venue"
            data-venue={l.venue.id}
            data-status={l.status}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-content-default text-sm font-medium">{l.venue.name}</span>
              <StatusBadge variant={STATUS_TONE[l.status]}>{t(`status.${l.status}`)}</StatusBadge>
            </div>
            <Caption>{t('at', { club: l.club.name, city: l.venue.city })}</Caption>
            {l.status === 'ACTIVE' && l.hourlyRateCents !== null && l.lessonMinutes.length > 0 ? (
              <Caption data-testid="coach-venue-summary">
                {t('summary', {
                  rate: money(l.hourlyRateCents, l.currency),
                  lengths: l.lessonMinutes.join(', '),
                })}
              </Caption>
            ) : null}
            {l.missing.length > 0 ? (
              <Caption data-testid="coach-venue-missing">{t('missing')}</Caption>
            ) : null}
            <div className="gap-tight flex flex-wrap">
              {l.status === 'ACTIVE' ? (
                <>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setEditing(l.id)}
                    data-testid="coach-venue-terms"
                  >
                    {t('action.terms')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setEnding(l);
                      setConfirming(true);
                    }}
                    data-testid="coach-venue-end"
                  >
                    {t('action.end')}
                  </Button>
                </>
              ) : null}
              {l.status === 'REQUESTED' ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => end.trigger(l.id))}
                  data-testid="coach-venue-withdraw"
                >
                  {t('action.withdraw')}
                </Button>
              ) : null}
              {(l.status === 'DECLINED' || l.status === 'ENDED') && view.approved ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => ask.trigger(l.venue.id))}
                  data-testid="coach-venue-again"
                >
                  {t('action.again')}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
        {view.approved ? (
          <div className="px-4 py-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setSearching(true)}
              data-testid="coach-venue-add"
            >
              {t('add')}
            </Button>
          </div>
        ) : null}
      </ProfileSection>

      {error ? (
        <InlineNotice variant="error" data-testid="coach-venues-error">
          {t(`error.${error}` as never)}
        </InlineNotice>
      ) : null}

      <TimeOffSection seed={timeOffSeed} />

      {searching ? (
        <VenueSearchSheet
          open={searching}
          onOpenChange={setSearching}
          linked={new Set(live.map((l) => l.venue.id))}
          onAsk={async (venueId) => {
            const sent = await run(() => ask.trigger(venueId));
            if (sent) setSearching(false);
          }}
          busy={busy}
        />
      ) : null}

      {editingLink ? (
        <TermsSheet
          key={editingLink.id}
          link={editingLink}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={(next) => {
            setView(next);
            setEditing(null);
          }}
        />
      ) : null}

      {ending ? (
        <ConfirmDialog
          showModal={confirming}
          setShowModal={setConfirming}
          tone="danger"
          title={t('end.title', { venue: ending.venue.name })}
          description={t('end.confirm')}
          confirmLabel={t('action.end')}
          cancelLabel={t('action.cancel')}
          onConfirm={() => void run(() => end.trigger(ending.id))}
        />
      ) : null}
    </>
  );
}

// ─── Asking a venue ─────────────────────────────────────────────────────────

function VenueSearchSheet({
  open,
  onOpenChange,
  linked,
  onAsk,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  linked: ReadonlySet<string>;
  onAsk: (venueId: string) => void | Promise<void>;
  busy: boolean;
}) {
  const t = useTranslations('coachVenues');
  const [q, setQ] = useState('');
  const term = q.trim();
  // The public venue index: the same list a player searches.
  const getKey = useMemo(() => KEYS.venues(term ? { q: term, limit: 10 } : { limit: 10 }), [term]);
  const { data } = useV1SWRInfinite<{ id: string; name: string; city: string }>(getKey);
  const venues = data ? data.flatMap((p) => p.items) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('search.title')} size="sm">
      <Sheet.Header title={t('search.title')} description={t('search.description')} />
      <Sheet.Body className="gap-compact grid content-start">
        <div className="grid gap-1.5">
          <Label htmlFor="coach-venue-search">{t('search.label')}</Label>
          <Input
            id="coach-venue-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
            data-testid="coach-venue-search"
          />
        </div>
        {venues && venues.length === 0 ? (
          <p className="text-content-muted text-sm">{t('search.empty')}</p>
        ) : null}
        <ul className="divide-border-subtle divide-y" data-testid="coach-venue-results">
          {(venues ?? []).map((v) => (
            <li key={v.id} className="flex min-h-14 items-center justify-between gap-3 py-2">
              <span className="min-w-0">
                <span className="text-content-default block truncate text-sm font-medium">
                  {v.name}
                </span>
                <Caption className="block">{v.city}</Caption>
              </span>
              {linked.has(v.id) ? (
                <StatusBadge variant="neutral">{t('status.ACTIVE')}</StatusBadge>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => void onAsk(v.id)}
                  data-testid="coach-venue-ask"
                  data-venue={v.id}
                >
                  {t('search.ask')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Sheet.Body>
    </Sheet>
  );
}

// ─── The terms at one venue ────────────────────────────────────────────────

type Stretch = { open: string; close: string };
type Week = Record<number, Stretch[]>;

const weekOf = (link: Link): Week =>
  Object.fromEntries(
    WEEK.map((d) => [
      d,
      link.hours.filter((h) => h.dayOfWeek === d).map((h) => ({ open: h.open, close: h.close })),
    ]),
  );

/** The week as `PUT …/hours` takes it. */
export function weekToHours(week: Week) {
  return WEEK.flatMap((d) =>
    (week[d] ?? []).map((s) => ({ dayOfWeek: d, open: s.open, close: s.close })),
  );
}

function TermsSheet({
  link,
  onOpenChange,
  onSaved,
}: {
  link: Link;
  onOpenChange: (open: boolean) => void;
  onSaved: (next: CoachLinksView) => void;
}) {
  const t = useTranslations('coachVenues');
  const tDay = useTranslations('common.calendar.weekdayShort');
  const [hourly, setHourly] = useState(rateText(link.hourlyRateCents));
  const [group, setGroup] = useState(rateText(link.groupRateCents));
  const [lengths, setLengths] = useState<number[]>(link.lessonMinutes);
  const [cutoff, setCutoff] = useState(String(link.cancelCutoffHours));
  const [week, setWeek] = useState<Week>(() => weekOf(link));
  const [error, setError] = useState<string | null>(null);

  const saveTerms = useV1Mutation<void, CoachLinksView>({
    url: () => V1.coachLink(link.id),
    method: 'PUT',
    body: () => ({
      hourlyRateCents: parseRate(hourly),
      groupRateCents: group.trim() === '' ? null : parseRate(group),
      lessonMinutes: lengths,
      cancelCutoffHours: Number(cutoff),
    }),
  });
  const saveHours = useV1Mutation<void, CoachLinksView>({
    url: () => V1.coachLinkHours(link.id),
    method: 'PUT',
    body: () => ({ hours: weekToHours(week) }),
  });
  const busy = saveTerms.isMutating || saveHours.isMutating;

  async function save() {
    setError(null);
    // Said here without a round trip; the server checks all of it again.
    if (parseRate(hourly) === null) return setError('hourlyRateCents');
    if (group.trim() !== '' && parseRate(group) === null) return setError('groupRateCents');
    if (lengths.length === 0) return setError('lessonMinutes');
    if (!/^\d{1,3}$/.test(cutoff.trim()) || Number(cutoff) > COACH_CUTOFF_MAX_HOURS) {
      return setError('cancelCutoffHours');
    }
    try {
      await saveTerms.trigger();
      const next = await saveHours.trigger();
      if (next) onSaved(next);
    } catch (e) {
      setError(venuesErrorKey(e));
    }
  }

  const setStretch = (d: number, i: number, patch: Partial<Stretch>) =>
    setWeek((w) => ({
      ...w,
      [d]: (w[d] ?? []).map((s, n) => (n === i ? { ...s, ...patch } : s)),
    }));

  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      title={t('terms.title', { venue: link.venue.name })}
      size="md"
    >
      <Sheet.Header
        title={t('terms.title', { venue: link.venue.name })}
        description={t('terms.description')}
      />
      <Sheet.Body className="gap-compact grid content-start" data-testid="coach-terms">
        <FormField label={t('terms.hourly', { currency: link.currency })}>
          <Input
            value={hourly}
            onChange={(e) => setHourly(e.target.value)}
            inputMode="decimal"
            autoComplete="off"
            data-testid="coach-terms-hourly"
          />
        </FormField>
        <FormField
          label={t('terms.group', { currency: link.currency })}
          description={t('terms.groupHint')}
        >
          <Input
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            inputMode="decimal"
            autoComplete="off"
            data-testid="coach-terms-group"
          />
        </FormField>

        <fieldset className="grid gap-1">
          <legend className="text-content-default text-sm font-medium">{t('terms.lengths')}</legend>
          <Caption>{t('terms.lengthsHint')}</Caption>
          <div className="flex flex-wrap gap-x-4">
            {link.lengthOptions.map((m) => {
              const id = `coach-length-${m}`;
              return (
                <div key={m} className="flex min-h-11 items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={lengths.includes(m)}
                    onCheckedChange={(v) =>
                      setLengths((cur) =>
                        v === true
                          ? [...cur.filter((x) => x !== m), m]
                          : cur.filter((x) => x !== m),
                      )
                    }
                  />
                  <Label htmlFor={id} className="cursor-pointer">
                    {t('terms.minutes', { minutes: m })}
                  </Label>
                </div>
              );
            })}
          </div>
        </fieldset>

        <FormField label={t('terms.cutoff')} description={t('terms.cutoffHint')}>
          <Input
            value={cutoff}
            onChange={(e) => setCutoff(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            data-testid="coach-terms-cutoff"
          />
        </FormField>

        <fieldset className="grid gap-1">
          <legend className="text-content-default text-sm font-medium">{t('terms.hours')}</legend>
          <Caption>{t('terms.hoursHint')}</Caption>
          <ul className="divide-border-subtle divide-y">
            {WEEK.map((d) => {
              const day = tDay(String(d) as never);
              const stretches = week[d] ?? [];
              return (
                <li key={d} className="grid gap-1 py-2" data-testid={`coach-hours-day-${d}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-content-default text-sm font-medium">{day}</span>
                    {stretches.length === 0 ? <Caption>{t('terms.dayOff')}</Caption> : null}
                    {stretches.length < COACH_HOURS_PER_DAY_MAX ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setWeek((w) => ({
                            ...w,
                            [d]: [...(w[d] ?? []), { open: '09:00', close: '12:00' }],
                          }))
                        }
                        data-testid={`coach-hours-add-${d}`}
                      >
                        {t('terms.addStretch')}
                      </Button>
                    ) : null}
                  </div>
                  {stretches.map((s, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      {/* From and to stay on one line; the vendored Input fills
                          its box, so each gets a box of its own. Only the
                          button may wrap under them on a narrow phone. */}
                      <span className="flex items-center gap-2">
                        <span className="w-28 shrink-0">
                          <Input
                            type="time"
                            step={900}
                            value={s.open}
                            onChange={(e) => setStretch(d, i, { open: e.target.value })}
                            aria-label={t('terms.fromLabel', { day, n: i + 1 })}
                          />
                        </span>
                        <span aria-hidden="true">–</span>
                        <span className="w-28 shrink-0">
                          <Input
                            type="time"
                            step={900}
                            value={s.close}
                            onChange={(e) => setStretch(d, i, { close: e.target.value })}
                            aria-label={t('terms.toLabel', { day, n: i + 1 })}
                          />
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setWeek((w) => ({ ...w, [d]: (w[d] ?? []).filter((_, n) => n !== i) }))
                        }
                      >
                        {t('terms.removeStretch')}
                      </Button>
                    </div>
                  ))}
                </li>
              );
            })}
          </ul>
        </fieldset>

        {error ? (
          <InlineNotice variant="error" data-testid="coach-terms-error">
            {t(`error.${error}` as never)}
          </InlineNotice>
        ) : null}
        <div className="gap-tight flex">
          <Button
            type="button"
            loading={busy}
            disabled={busy}
            onClick={() => void save()}
            data-testid="coach-terms-save"
          >
            {t('terms.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t('action.cancel')}
          </Button>
        </div>
      </Sheet.Body>
    </Sheet>
  );
}

// ─── Days off ───────────────────────────────────────────────────────────────

function TimeOffSection({ seed }: { seed: TimeOffItem[] }) {
  const t = useTranslations('coachVenues');
  const format = useFormatter();
  const [items, setItems] = useState(seed);
  const [start, setStart] = useState('');
  const [endDate, setEndDate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = useV1Mutation<void, { items: TimeOffItem[] }>({
    url: () => V1.coachTimeOff(),
    body: () => ({
      startDate: start,
      ...(endDate ? { endDate } : {}),
      ...(note.trim() ? { note } : {}),
    }),
  });
  const remove = useV1Mutation<string, { items: TimeOffItem[] }>({
    url: (id) => V1.removeCoachTimeOff(id),
    method: 'DELETE',
  });

  async function run(what: () => Promise<{ items: TimeOffItem[] } | undefined>) {
    setError(null);
    try {
      const next = await what();
      if (next) setItems(next.items);
      return true;
    } catch (e) {
      setError(venuesErrorKey(e));
      return false;
    }
  }

  // A calendar date, shown as that date wherever the coach is reading it.
  const day = (ymd: string) =>
    format.dateTime(new Date(`${ymd}T12:00:00Z`), { dateStyle: 'medium', timeZone: TIME_ZONE });

  return (
    <ProfileSection title={t('timeOff.title')} testId="coach-time-off">
      <Caption className="px-4 py-2">{t('timeOff.hint')}</Caption>
      {items.length === 0 ? (
        <div className={PROFILE_ROW}>
          <span className="text-content-muted text-sm">{t('timeOff.none')}</span>
        </div>
      ) : (
        items.map((i) => (
          <div key={i.id} className={PROFILE_ROW} data-testid="coach-time-off-item">
            <span className="min-w-0">
              <span className="text-content-default block text-sm">
                {i.startDate === i.endDate
                  ? t('timeOff.one', { date: day(i.startDate) })
                  : t('timeOff.range', { start: day(i.startDate), end: day(i.endDate) })}
              </span>
              {i.note ? <Caption className="block truncate">{i.note}</Caption> : null}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={remove.isMutating}
              onClick={() => void run(() => remove.trigger(i.id))}
              data-testid="coach-time-off-remove"
            >
              {t('timeOff.remove')}
            </Button>
          </div>
        ))
      )}
      <form
        className="gap-compact grid px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!start) return;
          void run(() => add.trigger()).then((done) => {
            if (!done) return;
            setStart('');
            setEndDate('');
            setNote('');
          });
        }}
        data-testid="coach-time-off-form"
      >
        <div className="gap-compact flex flex-wrap">
          <FormField label={t('timeOff.start')}>
            <Input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
              data-testid="coach-time-off-start"
            />
          </FormField>
          <FormField label={t('timeOff.end')} description={t('timeOff.endHint')}>
            <Input
              type="date"
              value={endDate}
              min={start || undefined}
              onChange={(e) => setEndDate(e.target.value)}
              data-testid="coach-time-off-end"
            />
          </FormField>
        </div>
        <FormField label={t('timeOff.note')}>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={COACH_TIME_OFF_NOTE_MAX}
            autoComplete="off"
          />
        </FormField>
        {error ? (
          <InlineNotice variant="error" data-testid="coach-time-off-error">
            {t(`error.${error}` as never)}
          </InlineNotice>
        ) : null}
        <div>
          <Button
            type="submit"
            variant="secondary"
            loading={add.isMutating}
            disabled={add.isMutating || !start}
            data-testid="coach-time-off-add"
          >
            {t('timeOff.add')}
          </Button>
        </div>
      </form>
    </ProfileSection>
  );
}
