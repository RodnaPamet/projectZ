'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { LessonTimesDto } from '@/app/api/v1/_lib/coach-dto';
import type { BookingViewer } from '@/components/booking/booking-viewer';
import { CardListSkeleton } from '@/components/loading/shapes';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption, Heading } from '@/components/ui/typography';
import { KIND_CHOOSER_PATH, PHONE_STEP_PATH } from '@/lib/auth/landing';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';

import { lessonPagePath, type LessonPick } from './lesson-pick';
import { LessonSheet, type LessonBookingDto, type LessonSelection } from './LessonSheet';

/**
 * «Запишете урок» on a coach's page (#548; owner decisions 1, 2, 5).
 *
 * The player chooses where (when the coach teaches at more than one venue),
 * the sport (when the coach teaches more than one there), how long, a day,
 * and then a time. A time is offered only where the coach AND a court are
 * free for all of it; the court is chosen for them. Each time shows the whole
 * price for one player, and the sheet breaks it into the coach's fee and the
 * court's price before anything is booked.
 *
 * ═══ ONE DAY AT A TIME, FROM ONE ENDPOINT ═══
 *
 * Each choice is `GET /api/v1/coaches/{slug}/lesson-times`, the endpoint the
 * native app reads, under `KEYS.lessonTimes`. The page server-renders the
 * first one (`seed`) as that key's fallback; the rest load when picked.
 * `keepPreviousData` is off: another day's times under this day's label would
 * offer lessons that do not exist.
 *
 * ═══ A TIME SHOWN IS NOT A TIME HELD ═══
 *
 * Somebody else can take the coach or the court before the player confirms.
 * The database decides, and the sheet says which went and refreshes the day.
 * The court is the server's choice at that moment, so the request carries the
 * total that was shown (`expectedTotalCents`): a lesson that would cost more
 * is refused, not booked.
 *
 * ═══ THE URL CARRIES THE PICK ═══
 *
 * As on a venue page: the venue, sport, length, day and time are mirrored
 * into the query string (replace, not push), so a reload keeps them and a
 * signed-out visitor's «Запиши урок» can go to /login and back.
 */

export interface LessonVenue {
  linkId: string;
  name: string;
  club: string;
  timezone: string;
  sports: string[];
  lessonMinutes: number[];
  /** Today at the venue and the next 13 days, `YYYY-MM-DD`. */
  days: string[];
}

const MINUTE_MS = 60_000;

type Choice = Pick<LessonPick, 'linkId' | 'sport' | 'minutes' | 'day'>;

const keyOf = (c: Choice) => `${c.linkId}|${c.sport}|${c.minutes}|${c.day}`;

export function LessonBooking({
  coach,
  venues,
  initialPick,
  seed,
  renderedAt,
  viewer,
  own,
}: {
  coach: { slug: string; name: string };
  venues: LessonVenue[];
  initialPick: LessonPick;
  /** The first choice's times, rendered on the server; null when that read failed. */
  seed: LessonTimesDto | null;
  /** The server's clock at render, so the first paint agrees with the HTML. */
  renderedAt: string;
  viewer: BookingViewer;
  /** The coach looking at their own page: nothing to book here. */
  own: boolean;
}) {
  const t = useTranslations('coaches.lesson');
  const tVenue = useTranslations('venue');
  const tSports = useTranslations('sports');
  const format = useFormatter();
  const router = useRouter();

  const [now, setNow] = useState(() => Date.parse(renderedAt));
  const [choice, setChoice] = useState<Choice>({
    linkId: initialPick.linkId,
    sport: initialPick.sport,
    minutes: initialPick.minutes,
    day: initialPick.day,
  });
  const [pickedStart, setPickedStart] = useState<string | null>(initialPick.start);
  const [sheetOpen, setSheetOpen] = useState(
    () => initialPick.confirm && viewer === 'player' && !own,
  );

  // Re-read each minute, so a time that starts while the page is open stops
  // being offered. The server refuses a started lesson regardless.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(id);
  }, []);

  const venue = venues.find((v) => v.linkId === choice.linkId) ?? venues[0]!;
  const seedKey = keyOf(initialPick);

  const { data, error, mutate } = useV1SWR<LessonTimesDto>(
    KEYS.lessonTimes(coach.slug, {
      linkId: choice.linkId,
      date: choice.day,
      minutes: choice.minutes,
      sport: choice.sport || undefined,
    }),
    {
      fallbackData: seed && keyOf(choice) === seedKey ? seed : undefined,
      keepPreviousData: false,
    },
  );

  const offers = useMemo(
    () => (data ? data.times.filter((o) => Date.parse(o.startTs) > now) : undefined),
    [data, now],
  );

  // The pick, as the day's times offer it now. Derived, not stored: one that
  // was taken under the player's thumb, or has started, is no pick. While the
  // sheet is open the last one stays, so the sheet can say what happened.
  const [held, setHeld] = useState<LessonSelection | null>(null);
  const live = useMemo<LessonSelection | null>(() => {
    if (!pickedStart || !data || !offers) return null;
    const o = offers.find((x) => x.startTs === pickedStart);
    if (!o) return null;
    return {
      linkId: choice.linkId,
      sport: o.sport,
      minutes: choice.minutes,
      startTs: o.startTs,
      endTs: o.endTs,
      courtName: o.court.name,
      coachFeeCents: data.coachFeeCents,
      courtPriceCents: o.courtPriceCents,
      totalCents: o.totalCents,
      currency: data.currency,
    };
  }, [choice.linkId, choice.minutes, data, offers, pickedStart]);
  const selection = sheetOpen ? (held ?? live) : live;

  // Mirror the choice and the pick into the URL. Never `confirm`: a reload
  // must not reopen the sheet.
  useEffect(() => {
    const path = lessonPagePath(coach.slug, { ...choice, start: live?.startTs });
    if (`${window.location.pathname}${window.location.search}` !== path) {
      window.history.replaceState(window.history.state, '', path);
    }
  }, [coach.slug, choice, live?.startTs]);

  const booking = useV1Mutation<LessonSelection, LessonBookingDto>({
    url: () => V1.bookLesson(coach.slug),
    body: (s) => ({
      linkId: s.linkId,
      startTs: s.startTs,
      minutes: s.minutes,
      sport: s.sport,
      // Never booked for more than the player was shown.
      expectedTotalCents: s.totalCents,
    }),
    // A lesson is a booking: it is on /me/bookings, and the bell counts it.
    related: {
      infinite: [KEYS.meBookings()],
      keys: (key) => key === KEYS.notifications(),
    },
  });

  function choose(next: Partial<Choice>) {
    setChoice((prev) => {
      const linkId = next.linkId ?? prev.linkId;
      const v = venues.find((x) => x.linkId === linkId) ?? venues[0]!;
      const want = { ...prev, ...next, linkId };
      // Another venue has its own sports, lengths and days: what was chosen
      // is kept where that venue offers it too, and the first is taken where
      // it does not.
      return {
        linkId,
        sport: v.sports.includes(want.sport) ? want.sport : (v.sports[0] ?? ''),
        minutes: v.lessonMinutes.includes(want.minutes) ? want.minutes : (v.lessonMinutes[0] ?? 0),
        day: v.days.includes(want.day) ? want.day : (v.days[0] ?? ''),
      };
    });
    setPickedStart(null);
  }

  const price = (cents: number, currency: string) =>
    format.number(cents / 100, {
      style: 'currency',
      currency,
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    });
  const time = (iso: string) =>
    format.dateTime(new Date(iso), {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: venue.timezone,
    });
  const date = (iso: string) =>
    format.dateTime(new Date(iso), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: venue.timezone,
    });

  const dayOptions = useMemo(
    () =>
      venue.days.map((d, i) => ({
        value: d,
        label:
          i === 0
            ? tVenue('day.today')
            : i === 1
              ? tVenue('day.tomorrow')
              : // A calendar date, formatted as one: noon UTC read in UTC is
                // that date whatever the device's zone.
                format.dateTime(new Date(`${d}T12:00:00Z`), {
                  weekday: 'short',
                  day: 'numeric',
                  timeZone: 'UTC',
                }),
      })),
    [venue.days, format, tVenue],
  );

  const returnPath = (start: string) =>
    lessonPagePath(coach.slug, { ...choice, start, confirm: true });

  function book() {
    if (!live || own) return;
    if (viewer !== 'player' && viewer !== 'club') {
      // Back to this page, this venue, day and time, with the sheet open. A
      // signed-out visitor signs in first; an account that has not chosen
      // "Играч или треньор?" answers that first (#416); a player with no
      // confirmed phone number confirms one first (#500).
      const first =
        viewer === 'signed-out'
          ? '/login'
          : viewer === 'undecided'
            ? KIND_CHOOSER_PATH
            : PHONE_STEP_PATH;
      router.push(`${first}?next=${encodeURIComponent(returnPath(live.startTs))}`);
      return;
    }
    booking.reset();
    setHeld(live);
    setSheetOpen(true);
  }

  const blocked = own || viewer === 'club';

  return (
    <section
      aria-labelledby="coach-lesson-title"
      className="flex flex-col gap-4"
      data-testid="lesson-booking"
    >
      <Heading level={2} id="coach-lesson-title" className="text-lg">
        {t('title')}
      </Heading>

      {venues.length > 1 && (
        <div className="overflow-x-auto pb-1">
          <ToggleGroup
            ariaLabel={t('venueLabel')}
            options={venues.map((v) => ({ value: v.linkId, label: v.name }))}
            selected={choice.linkId}
            selectAction={(v) => choose({ linkId: v })}
            optionClassName="whitespace-nowrap"
          />
        </div>
      )}
      <Caption data-testid="lesson-venue">
        {t('at', { venue: venue.name, club: venue.club })}
      </Caption>

      {venue.sports.length > 1 && (
        <ToggleGroup
          size="sm"
          ariaLabel={t('sportLabel')}
          options={venue.sports.map((s) => ({ value: s, label: tSports(s as never) }))}
          selected={choice.sport}
          selectAction={(v) => choose({ sport: v })}
        />
      )}

      {venue.lessonMinutes.length > 1 && (
        <ToggleGroup
          size="sm"
          ariaLabel={t('lengthLabel')}
          options={venue.lessonMinutes.map((m) => ({
            value: String(m),
            label: tVenue('slots.minutes', { minutes: m }),
          }))}
          selected={String(choice.minutes)}
          selectAction={(v) => choose({ minutes: Number(v) })}
        />
      )}

      {/* The day picker scrolls sideways inside itself, never the page. */}
      <div className="overflow-x-auto pb-1">
        <ToggleGroup
          ariaLabel={tVenue('day.label')}
          options={dayOptions}
          selected={choice.day}
          selectAction={(v) => choose({ day: v })}
          optionClassName="whitespace-nowrap"
        />
      </div>

      {offers === undefined ? (
        error ? (
          <ErrorState
            title={tVenue('slots.errorTitle')}
            description={tVenue('slots.errorDescription')}
            onRetry={() => void mutate()}
          />
        ) : (
          <CardListSkeleton rows={1} />
        )
      ) : offers.length === 0 ? (
        <Caption data-testid="lesson-times-none">{t('none')}</Caption>
      ) : (
        <div
          role="group"
          aria-label={t('timesLabel')}
          className="grid grid-cols-3 gap-2 sm:grid-cols-4"
          data-testid="lesson-times"
          data-perf-ready
        >
          {offers.map((o) => {
            const selected = live?.startTs === o.startTs;
            return (
              <Button
                key={o.startTs}
                type="button"
                variant={selected ? 'primary' : 'secondary'}
                aria-pressed={selected}
                className="tabular-nums"
                data-testid="lesson-time"
                data-start={o.startTs}
                onClick={() => setPickedStart(o.startTs)}
              >
                {time(o.startTs)} · {price(o.totalCents, data!.currency)}
              </Button>
            );
          })}
        </div>
      )}

      {data ? (
        <Caption data-testid="lesson-price-note">
          {t('priceNote', { fee: price(data.coachFeeCents, data.currency) })}
        </Caption>
      ) : null}

      {own ? (
        <InlineNotice variant="info">{t('own')}</InlineNotice>
      ) : viewer === 'club' ? (
        <InlineNotice variant="info">{t('clubAccount')}</InlineNotice>
      ) : null}

      {/* The pick and the button, pinned above the tab bar on a phone. */}
      <div className="border-border-subtle bg-bg-page in-shell:rounded-lg in-shell:border in-shell:mx-0 sticky bottom-[var(--app-bottom-inset,0px)] z-10 -mx-6 flex items-center justify-between gap-3 border-t px-6 py-3 md:static md:mx-0 md:rounded-lg md:border">
        <div className="min-w-0">
          {live ? (
            <>
              <p
                className="text-content-emphasis truncate text-sm font-medium"
                data-testid="lesson-pick"
              >
                {t('pick', { date: date(live.startTs), time: time(live.startTs) })}
              </p>
              <Caption>
                {tVenue('selection.detail', {
                  price: price(live.totalCents, live.currency),
                  minutes: live.minutes,
                })}
              </Caption>
            </>
          ) : (
            <p className="text-content-muted text-sm">{t('prompt')}</p>
          )}
          {viewer === 'signed-out' && live && <Caption>{tVenue('signInHint')}</Caption>}
        </div>
        <Button
          type="button"
          variant="primary"
          disabled={!live || blocked}
          onClick={book}
          className="shrink-0"
          data-testid="lesson-book"
        >
          {t('book')}
        </Button>
      </div>

      {viewer === 'player' && !own && selection && data && (
        <LessonSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          coachName={coach.name}
          venueName={venue.name}
          timezone={venue.timezone}
          cutoffHours={data.cancelCutoffHours}
          selection={selection}
          booking={booking}
          now={now}
          returnPath={returnPath(selection.startTs)}
          onBooked={() => router.push('/me/bookings')}
          onGone={() => {
            void mutate();
          }}
          onPickAnother={() => {
            setSheetOpen(false);
            setHeld(null);
            setPickedStart(null);
          }}
        />
      )}
    </section>
  );
}
