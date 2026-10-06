'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';

import type { MyBookingDetailDto } from '@/app/api/v1/_lib/dto';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { ArrowUpRight, ChevronLeft, LocationPin } from '@/components/ui/icons/nucleo';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';
import { isApiClientError } from '@/lib/data/errors';
import { KEYS, V1, type InfiniteKey } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';

import { BOOKING_LIST_KEYS, STATUS_TONE } from '../MyBookingsList';
import { BookingPlayers } from './BookingPlayers';
import { directionsUrl } from './directions';

const ConfirmDialog = dynamic(() =>
  import('@/components/ui/confirm-dialog').then((m) => m.ConfirmDialog),
);

type Detail = MyBookingDetailDto;

/** What the cancel button says when the server refused it. */
export type CancelErrorKey = 'CUTOFF_PASSED' | 'NOT_CANCELLABLE' | 'FAILED';

export function cancelErrorKey(e: unknown): CancelErrorKey {
  if (!isApiClientError(e)) return 'FAILED';
  if (e.code === 'CANCELLATION_CUTOFF_PASSED') return 'CUTOFF_PASSED';
  // Already cancelled, or completed meanwhile: the re-read shows which.
  if (e.status === 409) return 'NOT_CANCELLABLE';
  return 'FAILED';
}

/**
 * Where the booking stands for the PLAYER's cancel button (#354, #359).
 *
 *   none     not cancellable at all (cancelled, completed, no-show): no button.
 *   open     before the venue's cutoff: the button works.
 *   passed   PENDING or CONFIRMED, but the cutoff is behind us: the button is
 *            shown disabled, with the reason and the club's phone, because a
 *            missing button reads as a bug and a disabled one explains itself.
 *
 * `cancellableUntil` is the server's (the DTO's), never recomputed here from
 * a cutoff the client would have to know. Pure, so it is tested directly.
 */
export function cancelState(
  b: Pick<Detail, 'cancellableUntil' | 'startTs'>,
  now: number,
): 'none' | 'open' | 'passed' {
  if (!b.cancellableUntil) return 'none';
  const until = Date.parse(b.cancellableUntil);
  return now <= until && now < Date.parse(b.startTs) ? 'open' : 'passed';
}

/** The optimistic cancel: what the server will say, shown at once. */
export function asCancelled(b: Detail, at: Date): Detail {
  return {
    ...b,
    status: 'CANCELLED',
    cancelledAt: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    cancellableUntil: null,
  };
}

/**
 * The clock: the server's render time for the first paint, so the server and
 * the browser render the same thing, then this device's, re-read every 30 s.
 * The server enforces the cutoff whatever this says.
 */
function useNow(serverNow: number): number {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 30_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, []);
  return now;
}

/**
 * One booking, in full (#359, audit P04): where, when, which court, the price
 * and that it is paid at the club, how to get there, who is playing, and
 * "Отмени" until the venue's cutoff.
 *
 * ═══ SEEDED, THEN THE SAME ENDPOINT AS iOS ═══
 *
 * page.tsx reads the booking through `getMyBooking` and the v1 mapper, so the
 * first paint is the booking. This holds it under `GET /api/v1/me/bookings/{id}`
 * and revalidates after paint and on focus.
 *
 * ═══ CANCEL IS OPTIMISTIC, AND THE SERVER STILL DECIDES ═══
 *
 * Confirming shows Отменена at once and POSTs the v1 cancel route, the one the
 * native app calls. A refusal rolls the badge back and says why; a 403
 * CANCELLATION_CUTOFF_PASSED, reached when the deadline passed while the page
 * sat open, says the same as the disabled state does. On success both tabs of
 * the list are refreshed, so going back shows the booking under Минали.
 */
export function BookingDetail({ seed, serverNow }: { seed: Detail; serverNow: number }) {
  const t = useTranslations('myBookings');
  const td = useTranslations('myBookings.detail');
  const tSports = useTranslations('sports');
  const format = useFormatter();
  const now = useNow(serverNow);
  const [confirming, setConfirming] = useState(false);
  const [cancelError, setCancelError] = useState<CancelErrorKey | null>(null);

  const key = KEYS.meBooking(seed.id);
  const { data } = useV1SWR<Detail>(key, { fallbackData: seed });
  const b = data ?? seed;

  const cancel = useV1Mutation<{ slug: string }, unknown, Detail>({
    url: ({ slug }) => V1.cancelBooking(slug, b.id),
    target: { key },
    update: (current) => asCancelled(current, new Date()),
    fallback: seed,
    related: {
      infinite: [
        BOOKING_LIST_KEYS.upcoming as InfiniteKey<unknown>,
        BOOKING_LIST_KEYS.past as InfiniteKey<unknown>,
      ],
    },
  });

  // Every time in the VENUE's zone, as the list does: a 19:00 court in Sofia
  // is at 19:00 in Sofia, wherever the phone is.
  const timeZone = b.venue.timezone;
  const date = format.dateTime(new Date(b.startTs), { dateStyle: 'full', timeZone });
  const from = format.dateTime(new Date(b.startTs), { timeStyle: 'short', timeZone });
  const to = format.dateTime(new Date(b.endTs), { timeStyle: 'short', timeZone });
  const price = format.number(b.totalCents / 100, { style: 'currency', currency: b.currency });
  const deadline = b.cancellableUntil
    ? format.dateTime(new Date(b.cancellableUntil), {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone,
      })
    : null;

  const state = cancelState(b, now);
  const passed = state === 'passed' || cancelError === 'CUTOFF_PASSED';

  async function confirmCancel() {
    if (!b.clubSlug) return;
    setCancelError(null);
    try {
      await cancel.trigger({ slug: b.clubSlug });
    } catch (e) {
      setCancelError(cancelErrorKey(e));
    }
  }

  return (
    <main
      data-perf-ready
      className="gap-section mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-6 md:px-6 md:py-10"
    >
      <Link
        href="/me/bookings"
        className="text-content-muted hover:text-content-emphasis inline-flex min-h-11 items-center gap-1 self-start text-sm transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        {td('back')}
      </Link>

      <div className="gap-compact flex items-start justify-between">
        <div className="min-w-0">
          <Heading level={1} className="break-words">
            {b.venue.name}
          </Heading>
          <Caption>
            {b.resource.name} · {tSports(b.resource.sport as never)}
          </Caption>
        </div>
        <StatusBadge
          variant={STATUS_TONE[b.status] ?? 'neutral'}
          className="shrink-0"
          data-testid="booking-status"
        >
          {t(`status.${b.status}` as never)}
        </StatusBadge>
      </div>

      <Card elevation="flat" density="none" className="divide-border-subtle divide-y">
        <Row label={td('when')}>
          <span className="block">{date}</span>
          <span className="block">
            {from} – {to}
          </span>
        </Row>
        <Row label={td('court')}>
          {b.resource.name} · {tSports(b.resource.sport as never)}
        </Row>
        <Row label={td('price')}>
          <span className="block">{price}</span>
          {b.payAtClub ? (
            <span className="text-content-muted block text-xs">{td('payAtClub')}</span>
          ) : null}
        </Row>
        <Row label={td('address')}>
          <span className="block">{b.venue.addressLine}</span>
          <span className="text-content-muted block">{b.venue.city}</span>
        </Row>
      </Card>

      <div className="gap-tight flex flex-wrap">
        <a
          href={directionsUrl(b.venue)}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: 'secondary' })}
          data-testid="booking-directions"
        >
          <LocationPin className="size-4" aria-hidden="true" />
          {td('directions')}
          <span className="sr-only"> {td('opensInNewTab')}</span>
        </a>
        {b.venue.publicSlug ? (
          <Link
            href={`/venues/${encodeURIComponent(b.venue.publicSlug)}`}
            className={buttonVariants({ variant: 'ghost' })}
          >
            {td('venuePage')}
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </Link>
        ) : null}
      </div>

      <BookingPlayers booking={b} date={date} time={from} />

      {state !== 'none' || cancelError ? (
        <section className="gap-tight flex flex-col" data-testid="booking-cancel">
          {passed ? (
            <InlineNotice variant="warning" data-testid="booking-cutoff-passed">
              {deadline ? td('cutoffPassed', { deadline }) : td('cutoffPassedNoDate')}{' '}
              {b.venue.phone ? (
                <a
                  href={`tel:${b.venue.phone.replace(/\s+/g, '')}`}
                  className="text-content-emphasis font-medium underline underline-offset-2"
                >
                  {td('callClub', { phone: b.venue.phone })}
                </a>
              ) : (
                td('contactClub')
              )}
            </InlineNotice>
          ) : state === 'open' && deadline ? (
            <Caption>{td('cancelUntil', { deadline })}</Caption>
          ) : null}

          {cancelError && cancelError !== 'CUTOFF_PASSED' ? (
            <InlineNotice variant="error">{td(`cancelError.${cancelError}`)}</InlineNotice>
          ) : null}

          {state !== 'none' ? (
            <Button
              type="button"
              variant="destructive"
              className="self-start"
              disabled={passed || !b.clubSlug}
              loading={cancel.isMutating}
              onClick={() => setConfirming(true)}
              data-testid="booking-cancel-button"
            >
              {td('cancel')}
            </Button>
          ) : null}
        </section>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          showModal={confirming}
          setShowModal={setConfirming}
          tone="danger"
          title={td('confirm.title')}
          description={td('confirm.description', { venue: b.venue.name, date, time: from })}
          confirmLabel={td('confirm.yes')}
          cancelLabel={td('confirm.no')}
          // Returns nothing, so the dialog closes at once and the badge turns
          // to Отменена under it (the optimistic update), as CourtsBoard does.
          onConfirm={() => void confirmCancel()}
        />
      ) : null}
    </main>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-14 items-start justify-between gap-4 px-4 py-3">
      <span className="text-content-muted shrink-0 text-sm">{label}</span>
      <span className="text-content-default min-w-0 text-right text-sm">{children}</span>
    </div>
  );
}
