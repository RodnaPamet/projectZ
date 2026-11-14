'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type {
  AvailabilityDto,
  BookingDto,
  MyBookingDto,
  VenueDetail,
  VenueSummary,
} from '@/app/api/v1/_lib/dto';
import type { BookingGameDto } from '@/app/api/v1/_lib/open-play-dto';
import { Refusal, refusalKind, type Selection } from '@/app/(public)/venues/[slug]/BookingSheet';
import { CardListSkeleton } from '@/components/loading/shapes';
import { SportBanner } from '@/components/sports/SportBanner';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption, Heading } from '@/components/ui/typography';
import { allowedMinutes } from '@/lib/booking/offers';
import { bookingDays } from '@/lib/booking/days';
import { cn } from '@/lib/cn';
import { isApiClientError, type ApiClientError } from '@/lib/data/errors';
import { v1Fetch } from '@/lib/data/fetcher';
import { KEYS, V1 } from '@/lib/data/keys';
import { useViewerId } from '@/lib/data/provider';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR, useV1SWRInfinite } from '@/lib/data/use-v1-swr';
import { cityLabel } from '@/lib/geo/cities';
import { OPEN_PLAY_NOTE_MAX } from '@/lib/open-play/limits';
import {
  anyGameHour,
  bookingsToOpen,
  createGame,
  gameBody,
  gameHours,
  MAX_SPOTS_ASKED,
  NEW_GAME_PATH,
} from '@/lib/open-play/new-game';
import { MAX_SPORT_LEVEL, MIN_SPORT_LEVEL } from '@/lib/profile/limits';
import { resourceNoun } from '@/lib/sports/resource-kinds';

const MINUTE_MS = 60_000;
/** How long typing must pause before the club search is read. */
const SEARCH_DEBOUNCE_MS = 300;
const LEVELS = Array.from(
  { length: MAX_SPORT_LEVEL - MIN_SPORT_LEVEL + 1 },
  (_, i) => MIN_SPORT_LEVEL + i,
);
/** How many days ahead the flow looks for the first hour a game can open on. */
const DAYS_TRIED = 7;

/**
 * «Създай игра» in one flow (#697), the phone's NewGameView on one page: the
 * sport, a club, the hour, the players; then «Създай игра» books the court
 * (paid at the club) and opens its game, and the person lands on the game,
 * on its booking's page. The person's own upcoming bookings come first, to
 * look for players on one already made.
 *
 * Every read is the native app's: `GET /venues?sport=`, `GET /venues/{id}`
 * (the zone, the cutoff), `GET /venues/{id}/availability?date=`. The writes
 * are `POST /t/{club}/bookings`, then `GET` and `PUT /me/bookings/{id}/game`
 * (`createGame` in src/lib/open-play/new-game.ts).
 */
export function NewGame({ sports, renderedAt }: { sports: string[]; renderedAt: string }) {
  const t = useTranslations('games.new');
  const tSports = useTranslations('sports');
  const tSlots = useTranslations('venue.slots');
  const tCities = useTranslations('cities');
  const router = useRouter();
  const viewerId = useViewerId();
  const ids = useId();

  const [now, setNow] = useState(() => Date.parse(renderedAt));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(id);
  }, []);

  const [sport, setSport] = useState<string | null>(sports[0] ?? null);
  const [day, setDay] = useState<string | null>(null);
  const [dayChosen, setDayChosen] = useState(false);
  const [lengths, setLengths] = useState<Record<string, number>>({});
  const [pick, setPick] = useState<Selection | null>(null);
  const [spots, setSpots] = useState(1);
  const [anyLevel, setAnyLevel] = useState(true);
  const [levelMin, setLevelMin] = useState(3);
  const [levelMax, setLevelMax] = useState(4);
  const [note, setNote] = useState('');
  const [noGame, setNoGame] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const busy = useRef(false);
  const failedFor = useRef<string | null>(null);

  // The person's own upcoming bookings that can still look for players.
  const mine = useV1SWRInfinite<MyBookingDto>(KEYS.meBookings({ when: 'upcoming' }));
  const toOpen = bookingsToOpen(mine.data?.flatMap((p) => p.items) ?? []);

  // The clubs with the sport and a price: the phone's list, 50 a page, with a
  // search for a name or a city, and «Покажи още» past the first fifty.
  const [clubQuery, setClubQuery] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setQ(clubQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [clubQuery]);
  const clubKey = useMemo(
    () => (sport ? KEYS.venues({ sport, q: q || undefined, limit: 50 }) : null),
    [sport, q],
  );
  const clubs = useV1SWRInfinite<VenueSummary>(clubKey);
  const bookable = (clubs.data?.flatMap((p) => p.items) ?? []).filter(
    (v) => v.fromPriceCents !== null,
  );
  const moreClubs = clubs.data?.[clubs.data.length - 1]?.nextCursor ?? null;
  // Held, not looked up: a new search must not take the chosen club away.
  const [club, setClub] = useState<VenueSummary | null>(null);
  const venueId = club?.id ?? null;

  const venue = useV1SWR<VenueDetail>(venueId ? KEYS.venue(venueId) : null);
  const tz = venue.data?.timezone ?? null;
  const cutoffHours = venue.data?.cancellationCutoffHours ?? 0;
  const days = useMemo(() => (tz ? bookingDays(new Date(now), tz) : []), [now, tz]);
  const shownDay = day ?? days[0] ?? null;

  const slots = useV1SWR<AvailabilityDto>(
    venueId && shownDay ? KEYS.venueAvailability(venueId, { date: shownDay }) : null,
    { keepPreviousData: false },
  );
  const courts = (slots.data?.resources ?? []).filter((r) => r.sport === sport);

  // On the first day with an hour a game can open on, as the phone: inside
  // the cutoff, today often has none. Only until the person picks a day.
  // Adjusted while rendering, not in an effect: the next day's read starts
  // with no frame of an empty grid between.
  if (
    !dayChosen &&
    slots.data &&
    slots.data.venueId === venueId &&
    tz &&
    sport &&
    shownDay &&
    !anyGameHour(slots.data.resources, sport, now, cutoffHours, tz)
  ) {
    const at = days.indexOf(shownDay);
    if (at >= 0 && at < DAYS_TRIED - 1) setDay(days[at + 1]!);
  }

  const booking = useV1Mutation<Selection, BookingDto>({
    url: () => V1.createBooking(club!.clubSlug),
    body: (s) => ({ resourceId: s.resourceId, startTs: s.startTs, endTs: s.endTs }),
    related: {
      infinite: [KEYS.meBookings(), KEYS.meBookings({ when: 'upcoming' })],
      keys: (key) => key === KEYS.notifications(),
    },
  });
  const openGame = useV1Mutation<
    { bookingId: string; body: ReturnType<typeof gameBody> },
    BookingGameDto
  >({
    url: (a) => V1.bookingGame(a.bookingId),
    method: 'PUT',
    body: (a) => a.body,
  });

  const format = useFormatter();
  const time = (iso: string) =>
    format.dateTime(new Date(iso), {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: tz ?? undefined,
    });
  const date = (iso: string) =>
    format.dateTime(new Date(iso), {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: tz ?? undefined,
    });
  const price = (cents: number, currency: string) =>
    format.number(cents / 100, {
      style: 'currency',
      currency,
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    });

  function chooseSport(next: string) {
    if (next === sport) return;
    setSport(next);
    setClub(null);
    resetHour();
  }
  function chooseClub(next: VenueSummary) {
    if (next.id === venueId) return;
    setClub(next);
    resetHour();
  }
  function resetHour() {
    setDay(null);
    setDayChosen(false);
    setPick(null);
    setLengths({});
    setNoGame(null);
    booking.reset();
  }

  const levelsInOrder = anyLevel || levelMin <= levelMax;

  async function create() {
    if (!pick || !club || busy.current || leaving) return;
    busy.current = true;
    setNoGame(null);
    const pickKey = `${pick.resourceId}|${pick.startTs}|${pick.minutes}`;
    try {
      const outcome = await createGame({
        // A booking that failed is re-sent with its own Idempotency-Key, so a
        // lost answer to a booking that landed books nothing twice.
        book: () => (failedFor.current === pickKey ? booking.retry() : booking.trigger(pick)),
        readGame: (id) => v1Fetch<BookingGameDto>(V1.bookingGame(id), { viewerId }),
        openGame: (bookingId, body) => openGame.trigger({ bookingId, body }),
        wanted: {
          spots,
          levelMin: anyLevel ? null : levelMin,
          levelMax: anyLevel ? null : levelMax,
          note,
        },
      });
      failedFor.current = null;
      if (!outcome) return;
      if (outcome.kind === 'opened') {
        setLeaving(true);
        router.push(`/me/bookings/${encodeURIComponent(outcome.bookingId)}`);
      } else {
        setNoGame(outcome.bookingId);
      }
    } catch (err) {
      failedFor.current = pickKey;
      // The hour went under the person's thumb: the day again, and a new pick.
      if (isApiClientError(err) && refusalKind(err) === 'gone') {
        setPick(null);
        void slots.mutate();
      }
    } finally {
      busy.current = false;
    }
  }

  const refusal: ApiClientError | null = booking.error;

  return (
    <div className="gap-section mt-6 grid">
      {toOpen.length > 0 && (
        <section aria-labelledby={`${ids}-mine`} className="gap-tight grid">
          <Heading level={2} id={`${ids}-mine`}>
            {t('mine')}
          </Heading>
          <Caption>{t('mineHint')}</Caption>
          <ul className="grid gap-2 sm:grid-cols-2">
            {toOpen.map((b) => (
              <li key={b.id}>
                <Link
                  href={`/me/bookings/${encodeURIComponent(b.id)}`}
                  data-id={b.id}
                  className="border-border-default bg-bg-default hover:border-border-emphasis focus-visible:ring-ring block rounded-lg border px-4 py-3 outline-none focus-visible:ring-2"
                >
                  <span className="text-content-emphasis block text-sm font-medium tabular-nums">
                    {format.dateTime(new Date(b.startTs), {
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                      hourCycle: 'h23',
                      timeZone: b.venue.timezone,
                    })}
                  </span>
                  <span className="text-content-muted block text-sm">
                    {b.venue.name} · {b.resource.name}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 1. The sport. */}
      <section aria-labelledby={`${ids}-sport`} className="gap-tight grid">
        <Heading level={2} id={`${ids}-sport`}>
          {t('sport')}
        </Heading>
        {sports.length === 0 ? (
          <EmptyState title={t('noSports')} size="sm" />
        ) : (
          <div className="in-shell:mx-0 in-shell:px-0 -mx-6 overflow-x-auto px-6 md:mx-0 md:px-0">
            <ToggleGroup
              size="sm"
              ariaLabel={t('sport')}
              options={sports.map((s) => ({ value: s, label: tSports(s as never) }))}
              selected={sport ?? ''}
              selectAction={chooseSport}
              optionClassName="whitespace-nowrap"
            />
          </div>
        )}
        {sport && <SportBanner sport={sport} title={tSports(sport as never)} className="mt-2" />}
      </section>

      {/* 2. The club. */}
      {sport && (
        <section aria-labelledby={`${ids}-club`} className="gap-tight grid">
          <Heading level={2} id={`${ids}-club`}>
            {t('club')}
          </Heading>
          <Input
            type="search"
            value={clubQuery}
            onChange={(e) => setClubQuery(e.target.value)}
            aria-label={t('clubSearch')}
            placeholder={t('clubSearchPlaceholder')}
            enterKeyHint="search"
            autoComplete="off"
            data-testid="new-game-club-search"
          />
          {clubs.data === undefined ? (
            clubs.error ? (
              <ErrorState
                title={t('clubsError')}
                description={t('tryAgain')}
                onRetry={() => void clubs.mutate()}
              />
            ) : (
              <CardListSkeleton rows={3} />
            )
          ) : bookable.length === 0 ? (
            <EmptyState title={t('noClubs')} size="sm" />
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2" data-testid="new-game-clubs">
              {bookable.map((v) => {
                const chosen = v.id === venueId;
                return (
                  <li key={v.id}>
                    <button
                      type="button"
                      aria-pressed={chosen}
                      data-id={v.id}
                      onClick={() => chooseClub(v)}
                      className={cn(
                        'w-full rounded-lg border px-4 py-3 text-left transition-colors',
                        'focus-visible:shadow-[0_0_0_2px_var(--bg-default),0_0_0_4px_var(--focus-ring)] focus-visible:outline-none',
                        chosen
                          ? 'border-content-brand bg-[var(--selected-fill)] shadow-[inset_0_0_0_1px_var(--content-brand)]'
                          : 'border-border-default bg-bg-default hover:border-[var(--selected-edge)]',
                      )}
                    >
                      <span className="text-content-emphasis block font-medium">{v.name}</span>
                      <span className="text-content-muted block text-sm">
                        {cityLabel(tCities, v.city)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {moreClubs && (
            <Button
              type="button"
              variant="secondary"
              className="justify-self-start"
              loading={clubs.isValidating}
              onClick={() => void clubs.setSize(clubs.size + 1)}
            >
              {t('moreClubs')}
            </Button>
          )}
        </section>
      )}

      {/* 3. The day and the hour, from the club's cutoff on. */}
      {sport && club && (
        <section aria-labelledby={`${ids}-hour`} className="gap-tight grid">
          <Heading level={2} id={`${ids}-hour`}>
            {t('hour')}
          </Heading>
          {cutoffHours > 0 && <Caption>{t('cutoff', { hours: cutoffHours })}</Caption>}
          {/* An hour taken meanwhile: said here, where the next one is picked. */}
          {refusal && !pick && <Refusal error={refusal} returnPath={NEW_GAME_PATH} />}
          {venue.data === undefined || !shownDay ? (
            venue.error ? (
              <ErrorState
                title={t('slotsError')}
                description={t('tryAgain')}
                onRetry={() => void venue.mutate()}
              />
            ) : (
              <CardListSkeleton rows={2} />
            )
          ) : (
            <>
              <div className="in-shell:mx-0 in-shell:px-0 -mx-6 overflow-x-auto px-6 pb-1 md:mx-0 md:px-0">
                <ToggleGroup
                  ariaLabel={t('day')}
                  options={days.map((d, i) => ({
                    value: d,
                    label:
                      i === 0
                        ? t('today')
                        : i === 1
                          ? t('tomorrow')
                          : format.dateTime(new Date(`${d}T12:00:00Z`), {
                              weekday: 'short',
                              day: 'numeric',
                              timeZone: 'UTC',
                            }),
                  }))}
                  selected={shownDay}
                  selectAction={(d) => {
                    setDay(d);
                    setDayChosen(true);
                    setPick(null);
                  }}
                  optionClassName="whitespace-nowrap"
                />
              </div>
              {slots.data === undefined ? (
                slots.error ? (
                  <ErrorState
                    title={t('slotsError')}
                    description={t('tryAgain')}
                    onRetry={() => void slots.mutate()}
                  />
                ) : (
                  <CardListSkeleton rows={2} />
                )
              ) : courts.length === 0 ? (
                <EmptyState title={t('noCourts')} size="sm" />
              ) : (
                <div className="flex flex-col gap-3" data-testid="new-game-hours">
                  {courts.map((r) => {
                    const lengthsHere = allowedMinutes(r);
                    const chosen = lengths[r.resourceId] ?? r.minBookingMinutes;
                    const grid = gameHours(r, chosen, now, cutoffHours, tz!);
                    return (
                      <Card
                        key={r.resourceId}
                        as="article"
                        density="compact"
                        className="flex flex-col gap-3"
                      >
                        <SportBanner
                          sport={r.sport}
                          title={r.name}
                          subtitle={tSports(r.sport as never)}
                          headingLevel={3}
                        />
                        {lengthsHere.length > 1 && (
                          <ToggleGroup
                            size="sm"
                            ariaLabel={tSlots('durationLabel', { court: r.name })}
                            options={lengthsHere.map((m) => ({
                              value: String(m),
                              label: tSlots('minutes', { minutes: m }),
                            }))}
                            selected={String(chosen)}
                            selectAction={(v) => {
                              setLengths((prev) => ({ ...prev, [r.resourceId]: Number(v) }));
                              if (pick?.resourceId === r.resourceId) setPick(null);
                            }}
                          />
                        )}
                        {grid.length === 0 ? (
                          <Caption>{tSlots('none')}</Caption>
                        ) : (
                          <div
                            role="group"
                            aria-label={tSlots('courtTimes', { court: r.name })}
                            className="flex flex-col gap-3"
                          >
                            {grid.map((g) => (
                              <div key={g.part} className="flex flex-col gap-2">
                                <p className="text-content-muted text-sm font-semibold">
                                  {tSlots(g.part)}
                                </p>
                                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                                  {g.cells.map(({ startTs, offer: o }) => {
                                    if (!o) return null;
                                    const selected =
                                      pick?.resourceId === r.resourceId &&
                                      pick.startTs === o.startTs &&
                                      pick.minutes === o.minutes;
                                    return (
                                      <button
                                        key={startTs}
                                        type="button"
                                        aria-pressed={selected}
                                        aria-label={`${time(o.startTs)} · ${price(o.priceCents, r.currency)}`}
                                        className={cn(
                                          'flex min-h-14 flex-col justify-center rounded-[11px] border px-2.5 py-2 text-left transition-colors',
                                          'focus-visible:shadow-[0_0_0_2px_var(--bg-default),0_0_0_4px_var(--focus-ring)] focus-visible:outline-none',
                                          selected
                                            ? 'border-content-brand bg-[var(--selected-fill)] shadow-[inset_0_0_0_1px_var(--content-brand)]'
                                            : 'border-border-default bg-bg-default hover:border-[var(--selected-edge)]',
                                        )}
                                        onClick={() => {
                                          setNoGame(null);
                                          booking.reset();
                                          setPick({
                                            resourceId: r.resourceId,
                                            courtName: r.name,
                                            noun: resourceNoun(r.resourceType),
                                            currency: r.currency,
                                            ...o,
                                          });
                                        }}
                                      >
                                        <span className="font-display text-content-emphasis text-xl leading-none font-extrabold tabular-nums">
                                          {time(o.startTs)}
                                        </span>
                                        <span
                                          className={cn(
                                            'text-xs tabular-nums',
                                            selected ? 'text-content-brand' : 'text-content-muted',
                                          )}
                                        >
                                          {price(o.priceCents, r.currency)}
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </Card>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* 4. The players wanted, then «Създай игра». */}
      {pick && club && (
        <section
          aria-labelledby={`${ids}-players`}
          className="gap-section grid"
          data-testid="new-game-players"
        >
          <Heading level={2} id={`${ids}-players`}>
            {t('players')}
          </Heading>

          <div className="gap-tight grid">
            <span className="text-content-default text-sm">{t('spots')}</span>
            <ToggleGroup
              ariaLabel={t('spots')}
              options={Array.from({ length: MAX_SPOTS_ASKED }, (_, i) => ({
                value: String(i + 1),
                label: String(i + 1),
              }))}
              selected={String(spots)}
              selectAction={(v) => setSpots(Number(v))}
              className="justify-self-start"
              optionClassName="min-h-11 min-w-11"
            />
            <Caption>{t('spotsHint')}</Caption>
          </div>

          <div className="gap-tight grid">
            <span className="text-content-default text-sm">{t('level')}</span>
            <ToggleGroup
              ariaLabel={t('level')}
              options={[
                { value: 'any', label: t('anyLevel') },
                { value: 'range', label: t('pickLevel') },
              ]}
              selected={anyLevel ? 'any' : 'range'}
              selectAction={(v) => setAnyLevel(v === 'any')}
              className="justify-self-start"
              optionClassName="min-h-11 whitespace-nowrap"
            />
            {!anyLevel && (
              <div className="gap-tight grid">
                <Caption>{t('levelFrom')}</Caption>
                <ToggleGroup
                  size="sm"
                  ariaLabel={t('levelFrom')}
                  options={LEVELS.map((l) => ({ value: String(l), label: String(l) }))}
                  selected={String(levelMin)}
                  selectAction={(v) => setLevelMin(Number(v))}
                  className="justify-self-start"
                  optionClassName="min-h-11 min-w-10"
                />
                <Caption>{t('levelTo')}</Caption>
                <ToggleGroup
                  size="sm"
                  ariaLabel={t('levelTo')}
                  options={LEVELS.map((l) => ({ value: String(l), label: String(l) }))}
                  selected={String(levelMax)}
                  selectAction={(v) => setLevelMax(Number(v))}
                  className="justify-self-start"
                  optionClassName="min-h-11 min-w-10"
                />
                {!levelsInOrder && <InlineNotice variant="warning">{t('levelOrder')}</InlineNotice>}
              </div>
            )}
          </div>

          <div className="gap-tight grid">
            <Label htmlFor={`${ids}-note`}>{t('note')}</Label>
            <Textarea
              id={`${ids}-note`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={OPEN_PLAY_NOTE_MAX}
              placeholder={t('notePlaceholder')}
              data-testid="new-game-note"
            />
          </div>

          <Card density="compact" className="flex flex-col gap-1" data-testid="new-game-summary">
            <p className="text-content-emphasis font-medium">
              {date(pick.startTs)}, {time(pick.startTs)}–{time(pick.endTs)}
            </p>
            <p className="text-content-muted text-sm">
              {club.name} · {pick.courtName} · {price(pick.priceCents, pick.currency)}
            </p>
            <Caption>{t('payAtClub')}</Caption>
          </Card>

          {refusal && <Refusal error={refusal} returnPath={NEW_GAME_PATH} />}
          {noGame && (
            <InlineNotice variant="warning" title={t('noGameTitle')} data-testid="new-game-no-game">
              <p>{t('noGame')}</p>
              <Link
                href={`/me/bookings/${encodeURIComponent(noGame)}`}
                className={cn(buttonVariants({ variant: 'secondary' }), 'mt-2')}
              >
                {t('toBooking')}
              </Link>
            </InlineNotice>
          )}

          {!noGame && (
            <Button
              type="button"
              variant="primary"
              className="justify-self-start"
              loading={booking.isMutating || openGame.isMutating || leaving}
              disabled={!levelsInOrder || booking.isMutating || openGame.isMutating || leaving}
              onClick={() => void create()}
              data-testid="new-game-create"
            >
              {t('create')}
            </Button>
          )}
        </section>
      )}
    </div>
  );
}
