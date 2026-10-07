'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { AvailabilityDto, BookingDto, ResourceSlotsDto } from '@/app/api/v1/_lib/dto';
import { CardListSkeleton } from '@/components/loading/shapes';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption, Heading } from '@/components/ui/typography';
import { KEYS, V1 } from '@/lib/data/keys';
import { sendUsageBeacon } from '@/lib/data/usage-beacon';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';
import { resourceNoun } from '@/lib/sports/resource-kinds';

import { venuePagePath, type InitialPick } from './booking-days';
import { BookingSheet, type Selection } from './BookingSheet';

/**
 * The day picker, every court's free times, and "Резервирай" (#355).
 *
 * ═══ ONE DAY AT A TIME, FROM ONE ENDPOINT ═══
 *
 * Each day is `GET /api/v1/venues/{id}/availability?date=` — the endpoint the
 * native app reads — under `KEYS.venueAvailability`. The page server-renders
 * one day (`seed`) and hands it over as that key's fallback, so it paints with
 * the HTML and SWR revalidates it after paint. Other days load when picked;
 * `keepPreviousData` is OFF here, because yesterday's grid under today's label
 * would offer slots that do not exist.
 *
 * ═══ WHAT IS OFFERED ═══
 *
 * A slot is offered when it is free, has not started (by this browser's clock,
 * re-read each minute — the server refuses a started slot with 400
 * SLOT_NOT_BOOKABLE anyway), and can be booked for the court's chosen length
 * (`durations`, Q16). The price on each is the server's quote for that length.
 * A slot shown free can still be taken by the time it is confirmed: the
 * database's EXCLUDE constraint decides, and the sheet turns 409 SLOT_TAKEN
 * into "choose another" and refreshes the day.
 *
 * ═══ THE URL CARRIES THE PICK ═══
 *
 * The day and the picked slot are mirrored into the query string (replace, not
 * push), so a reload keeps them and a signed-out visitor's "Резервирай" can
 * send them to /login and back (`venuePagePath`).
 */

export type Viewer = 'signed-out' | 'player' | 'club';

interface VenueProps {
  id: string;
  name: string;
  publicSlug: string;
  clubSlug: string;
  timezone: string;
  cancellationCutoffHours: number;
}

/** A free start on one court, offered for one length. */
interface Offer {
  startTs: string;
  endTs: string;
  minutes: number;
  priceCents: number;
}

const MINUTE_MS = 60_000;

/** The lengths a court allows: whole units of its minimum, up to its maximum. */
export function allowedMinutes(
  r: Pick<ResourceSlotsDto, 'minBookingMinutes' | 'maxBookingMinutes'>,
) {
  const out: number[] = [];
  const unit = r.minBookingMinutes;
  if (!(unit > 0)) return out;
  for (let m = unit; m <= (r.maxBookingMinutes ?? unit); m += unit) out.push(m);
  return out;
}

/** The free starts on one court for one length, not yet begun at `now`. */
export function offersFor(r: ResourceSlotsDto, minutes: number, now: number): Offer[] {
  const out: Offer[] = [];
  for (const s of r.slots) {
    if (!s.available || Date.parse(s.startTs) <= now) continue;
    const d = s.durations?.find((x) => x.minutes === minutes);
    if (d) out.push({ startTs: s.startTs, endTs: d.endTs, minutes, priceCents: d.priceCents });
  }
  return out;
}

/** The pick the URL asked for, if the seed still offers it. */
function initialSelection(pick: InitialPick, seed: AvailabilityDto, now: number): Selection | null {
  if (!pick.court || !pick.start) return null;
  const r = seed.resources.find((x) => x.resourceId === pick.court);
  if (!r) return null;
  const minutes = pick.minutes ?? r.minBookingMinutes;
  const offer = offersFor(r, minutes, now).find((o) => o.startTs === pick.start);
  if (!offer) return null;
  return {
    resourceId: r.resourceId,
    courtName: r.name,
    noun: resourceNoun(r.resourceType),
    currency: r.currency,
    ...offer,
  };
}

export function VenueBooking({
  venue,
  days,
  seed,
  initialPick,
  renderedAt,
  viewer,
}: {
  venue: VenueProps;
  /** Today at the club and the next 13 days, `YYYY-MM-DD`. */
  days: string[];
  seed: { day: string; availability: AvailabilityDto };
  initialPick: InitialPick;
  /** The server's clock at render, so the first paint agrees with the HTML. */
  renderedAt: string;
  viewer: Viewer;
}) {
  const t = useTranslations('venue');
  const format = useFormatter();
  const router = useRouter();

  const [now, setNow] = useState(() => Date.parse(renderedAt));
  const [day, setDay] = useState(initialPick.day);
  const [picked, setSelection] = useState<Selection | null>(() =>
    initialSelection(initialPick, seed.availability, Date.parse(renderedAt)),
  );
  const [lengths, setLengths] = useState<Record<string, number>>(() =>
    picked ? { [picked.resourceId]: picked.minutes } : {},
  );
  const [sheetOpen, setSheetOpen] = useState(
    () => initialPick.confirm && viewer === 'player' && picked !== null,
  );

  // Re-read each minute, so a slot that starts while the page is open stops
  // being offered. Seeded with the server's render time, which a cached page
  // has at most 30 s stale (docs/perf/navigation-policy.md); the server refuses
  // a started slot regardless.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(id);
  }, []);

  const key = KEYS.venueAvailability(venue.id, { date: day });
  const { data, error, mutate } = useV1SWR<AvailabilityDto>(key, {
    fallbackData: day === seed.day ? seed.availability : undefined,
    keepPreviousData: false,
  });

  // A pick that is no longer offered — taken under the player's thumb, or
  // started — is no pick. Derived, not stored, so it cannot go stale; while the
  // sheet is open it stays, so the sheet can say what happened to it.
  const selection = useMemo(() => {
    if (!picked || sheetOpen || !data) return picked;
    const r = data.resources.find((x) => x.resourceId === picked.resourceId);
    const offered =
      r && offersFor(r, picked.minutes, now).some((o) => o.startTs === picked.startTs);
    return offered ? picked : null;
  }, [data, now, picked, sheetOpen]);

  // Mirror the day and the pick into the URL. Never `confirm`: a reload must
  // not reopen the sheet.
  useEffect(() => {
    const path = venuePagePath(venue.publicSlug, {
      day,
      court: selection?.resourceId,
      start: selection?.startTs,
      minutes: selection?.minutes,
    });
    if (`${window.location.pathname}${window.location.search}` !== path) {
      window.history.replaceState(window.history.state, '', path);
    }
  }, [venue.publicSlug, day, selection]);

  const booking = useV1Mutation<Selection, BookingDto>({
    url: () => V1.createBooking(venue.clubSlug),
    body: (s) => ({ resourceId: s.resourceId, startTs: s.startTs, endTs: s.endTs }),
    // The cross-club list /me/bookings renders, so the new booking is on it;
    // and the bell (#367), so "Резервацията е потвърдена" is counted at once
    // rather than at the next minute's poll.
    related: {
      infinite: [KEYS.meBookings()],
      keys: (key) => key === KEYS.notifications(),
    },
  });

  const dayOptions = useMemo(
    () =>
      days.map((d, i) => ({
        value: d,
        label:
          i === 0
            ? t('day.today')
            : i === 1
              ? t('day.tomorrow')
              : // A calendar date, formatted as one: noon UTC read in UTC is
                // that date whatever the device's zone.
                format.dateTime(new Date(`${d}T12:00:00Z`), {
                  weekday: 'short',
                  day: 'numeric',
                  timeZone: 'UTC',
                }),
      })),
    [days, format, t],
  );

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

  function pickDay(next: string) {
    if (next === day) return;
    setDay(next);
    setSelection(null);
  }

  function book() {
    if (!selection) return;
    if (viewer === 'signed-out') {
      // Back to this page, this day, this slot, with the sheet open. Built from
      // the page's own state (venuePagePath); /login validates it again.
      const next = venuePagePath(venue.publicSlug, {
        day,
        court: selection.resourceId,
        start: selection.startTs,
        minutes: selection.minutes,
        confirm: true,
      });
      router.push(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    booking.reset();
    setSheetOpen(true);
    // A funnel step only the browser sees (#371): anonymous, after the tap.
    sendUsageBeacon(venue.id, 'SHEET_OPENED');
  }

  const resources = data?.resources;

  return (
    <section aria-labelledby="venue-slots-title" className="flex flex-col gap-4">
      <div className="in-shell:px-0 px-6 md:px-0">
        <Heading level={2} id="venue-slots-title">
          {t('slots.title')}
        </Heading>
      </div>

      {/* The day picker scrolls sideways inside itself, never the page. */}
      <div className="in-shell:px-0 overflow-x-auto px-6 pb-1 md:px-0">
        <ToggleGroup
          ariaLabel={t('day.label')}
          options={dayOptions}
          selected={day}
          selectAction={pickDay}
          optionClassName="whitespace-nowrap"
        />
      </div>

      <div className="in-shell:px-0 flex flex-col gap-3 px-6 md:px-0">
        {resources === undefined ? (
          error ? (
            <ErrorState
              title={t('slots.errorTitle')}
              description={t('slots.errorDescription')}
              onRetry={() => void mutate()}
            />
          ) : (
            <CardListSkeleton rows={3} />
          )
        ) : resources.length === 0 ? (
          <EmptyState
            title={t('slots.noCourtsTitle')}
            description={t('slots.noCourts')}
            size="sm"
          />
        ) : (
          <div data-perf-ready className="flex flex-col gap-3">
            {resources.map((r) => {
              const lengthsHere = allowedMinutes(r);
              const chosen = lengths[r.resourceId] ?? r.minBookingMinutes;
              const offers = offersFor(r, chosen, now);
              return (
                <Card
                  key={r.resourceId}
                  as="article"
                  density="compact"
                  className="flex flex-col gap-3"
                >
                  <Heading level={3}>{r.name}</Heading>

                  {lengthsHere.length > 1 && (
                    <ToggleGroup
                      size="sm"
                      ariaLabel={t('slots.durationLabel', { court: r.name })}
                      options={lengthsHere.map((m) => ({
                        value: String(m),
                        label: t('slots.minutes', { minutes: m }),
                      }))}
                      selected={String(chosen)}
                      selectAction={(v) => {
                        setLengths((prev) => ({ ...prev, [r.resourceId]: Number(v) }));
                        if (selection?.resourceId === r.resourceId) setSelection(null);
                      }}
                    />
                  )}

                  {offers.length === 0 ? (
                    <Caption>{t('slots.none')}</Caption>
                  ) : (
                    <div
                      role="group"
                      aria-label={t('slots.courtTimes', { court: r.name })}
                      className="grid grid-cols-3 gap-2 sm:grid-cols-4"
                    >
                      {offers.map((o) => {
                        const selected =
                          selection?.resourceId === r.resourceId &&
                          selection.startTs === o.startTs &&
                          selection.minutes === o.minutes;
                        return (
                          <Button
                            key={o.startTs}
                            type="button"
                            variant={selected ? 'primary' : 'secondary'}
                            aria-pressed={selected}
                            className="tabular-nums"
                            onClick={() => {
                              if (selected) return;
                              setSelection({
                                resourceId: r.resourceId,
                                courtName: r.name,
                                noun: resourceNoun(r.resourceType),
                                currency: r.currency,
                                ...o,
                              });
                              // The funnel's "slot picked" (#371), once per pick.
                              sendUsageBeacon(venue.id, 'SLOT_PICKED');
                            }}
                          >
                            {time(o.startTs)} · {price(o.priceCents, r.currency)}
                          </Button>
                        );
                      })}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {viewer === 'club' && (
        <div className="in-shell:px-0 px-6 md:px-0">
          <InlineNotice variant="info">{t('clubAccount')}</InlineNotice>
        </div>
      )}

      {/* The pick and the button, pinned above the tab bar on a phone. Inside
          a signed-in shell, whose <main> pads, it is a card at every width
          rather than a strip that stops short of the screen edges. */}
      <div className="border-border-subtle bg-bg-page in-shell:rounded-lg in-shell:border sticky bottom-[var(--app-bottom-inset,0px)] z-10 flex items-center justify-between gap-3 border-t px-6 py-3 md:static md:rounded-lg md:border">
        <div className="min-w-0">
          {selection ? (
            <>
              <p className="text-content-emphasis truncate text-sm font-medium">
                {t('selection.summary', {
                  court: selection.courtName,
                  date: date(selection.startTs),
                  time: time(selection.startTs),
                })}
              </p>
              <Caption>
                {t('selection.detail', {
                  price: price(selection.priceCents, selection.currency),
                  minutes: selection.minutes,
                })}
              </Caption>
            </>
          ) : (
            <p className="text-content-muted text-sm">{t('selection.prompt')}</p>
          )}
          {viewer === 'signed-out' && selection && <Caption>{t('signInHint')}</Caption>}
        </div>
        <Button
          type="button"
          variant="primary"
          disabled={!selection || viewer === 'club'}
          onClick={book}
          className="shrink-0"
        >
          {t('book')}
        </Button>
      </div>

      {viewer === 'player' && selection && (
        <BookingSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          venueName={venue.name}
          timezone={venue.timezone}
          cutoffHours={venue.cancellationCutoffHours}
          selection={selection}
          booking={booking}
          now={now}
          signInPath={`/login?next=${encodeURIComponent(
            venuePagePath(venue.publicSlug, {
              day,
              court: selection.resourceId,
              start: selection.startTs,
              minutes: selection.minutes,
              confirm: true,
            }),
          )}`}
          onBooked={() => router.push('/me/bookings')}
          onSlotGone={() => {
            void mutate();
          }}
          onPickAnother={() => {
            setSheetOpen(false);
            setSelection(null);
          }}
        />
      )}
    </section>
  );
}
