'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { BookingDto } from '@/app/api/v1/_lib/dto';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Sheet } from '@/components/ui/sheet';
import type { ApiClientError } from '@/lib/data/errors';
import { isApiClientError } from '@/lib/data/errors';
import type { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { cn } from '@/lib/cn';
import type { ResourceNoun } from '@/lib/sports/resource-kinds';

/** The slot the player picked: one court, one start, one length. */
export interface Selection {
  resourceId: string;
  courtName: string;
  /** What the court is called (P51): a karting track is a "писта". */
  noun: ResourceNoun;
  currency: string;
  startTs: string;
  endTs: string;
  minutes: number;
  priceCents: number;
}

type BookingMutation = ReturnType<typeof useV1Mutation<Selection, BookingDto>>;

const HOUR_MS = 3_600_000;

/**
 * How the sheet answers a refused booking.
 *
 *   gone    the slot is no longer bookable (409 SLOT_TAKEN, 400
 *           SLOT_NOT_BOOKABLE): the day is refreshed and the player picks again.
 *   final   the player may not book this now, and retrying will not change it
 *           (403 NO_SHOW_BLOCKED, 409 BOOKING_LIMIT_REACHED, 403
 *           PLAYER_ACCOUNT_REQUIRED).
 *   signIn  the session ended (401): sign in and come back to this slot.
 *   retry   anything else, a dropped connection included. Confirming again
 *           re-sends the SAME Idempotency-Key, so a booking that did land is
 *           returned rather than made twice.
 */
export type RefusalKind = 'gone' | 'final' | 'signIn' | 'retry';

export function refusalKind(err: ApiClientError): RefusalKind {
  switch (err.code) {
    case 'SLOT_TAKEN':
    case 'SLOT_NOT_BOOKABLE':
      return 'gone';
    case 'NO_SHOW_BLOCKED':
    case 'BOOKING_LIMIT_REACHED':
    case 'PLAYER_ACCOUNT_REQUIRED':
      return 'final';
    default:
      return err.status === 401 ? 'signIn' : 'retry';
  }
}

/** `details.limit` and `details.upcoming` of 409 BOOKING_LIMIT_REACHED (#380), if present. */
function limitDetails(details: unknown): { limit: number; upcoming: number } | null {
  if (!details || typeof details !== 'object') return null;
  const { limit, upcoming } = details as Record<string, unknown>;
  return typeof limit === 'number' && typeof upcoming === 'number' ? { limit, upcoming } : null;
}

/**
 * The confirmation sheet (#355): court, date, time, length, price, paid at the
 * club, and the cancellation deadline; then one POST.
 *
 * ═══ ONE TAP, ONE BOOKING ═══
 *
 *   - The button is disabled while the request is in flight, and a ref guards
 *     the gap before React re-renders, so a double tap sends one request.
 *   - Each new attempt carries a fresh Idempotency-Key (`useV1Mutation`). An
 *     attempt that FAILED is re-sent with its own key (`retry`), so when the
 *     response was lost but the booking landed, the server replays it (200)
 *     instead of booking the court twice.
 *   - After success the button stays busy while the router moves to
 *     /me/bookings, so nothing can be sent in between.
 */
export function BookingSheet({
  open,
  onOpenChange,
  venueName,
  timezone,
  cutoffHours,
  selection,
  booking,
  now,
  signInPath,
  onBooked,
  onSlotGone,
  onPickAnother,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  venueName: string;
  timezone: string;
  cutoffHours: number;
  selection: Selection;
  booking: BookingMutation;
  now: number;
  signInPath: string;
  onBooked: () => void;
  onSlotGone: () => void;
  onPickAnother: () => void;
}) {
  const t = useTranslations('venue.sheet');
  const tVenue = useTranslations('venue');
  const format = useFormatter();
  const busy = useRef(false);
  const failedFor = useRef<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const selectionKey = `${selection.resourceId}|${selection.startTs}|${selection.minutes}`;

  const at = (iso: string | Date, withDate: boolean) =>
    format.dateTime(typeof iso === 'string' ? new Date(iso) : iso, {
      ...(withDate ? { weekday: 'long', day: 'numeric', month: 'long' } : {}),
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: timezone,
    });
  const day = format.dateTime(new Date(selection.startTs), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: timezone,
  });
  const price = format.number(selection.priceCents / 100, {
    style: 'currency',
    currency: selection.currency,
  });

  // The player's own cutoff, as `cancellableUntil` on the booking will say:
  // elapsed hours before the start (`playerCancellableUntil`).
  const deadline = new Date(Date.parse(selection.startTs) - cutoffHours * HOUR_MS);
  const canCancelOnline = deadline.getTime() > now;

  async function confirm() {
    if (busy.current || leaving) return;
    busy.current = true;
    try {
      const replayed = failedFor.current === selectionKey ? await booking.retry() : undefined;
      const made = replayed ?? (await booking.trigger(selection));
      if (!made) return;
      failedFor.current = null;
      setLeaving(true);
      onBooked();
    } catch (err) {
      failedFor.current = selectionKey;
      if (isApiClientError(err) && refusalKind(err) === 'gone') onSlotGone();
    } finally {
      busy.current = false;
    }
  }

  const error = booking.error;
  const refusal = error ? refusalKind(error) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('title')} description={venueName}>
      <Sheet.Header title={t('title')} description={venueName} />
      <Sheet.Body className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-content-muted">
            {t(selection.noun === 'track' ? 'track.court' : 'court')}
          </dt>
          <dd className="text-content-emphasis">{selection.courtName}</dd>
          <dt className="text-content-muted">{t('date')}</dt>
          <dd className="text-content-emphasis">{day}</dd>
          <dt className="text-content-muted">{t('time')}</dt>
          <dd className="text-content-emphasis tabular-nums">
            {t('timeRange', {
              start: at(selection.startTs, false),
              end: at(selection.endTs, false),
            })}
          </dd>
          <dt className="text-content-muted">{t('duration')}</dt>
          <dd className="text-content-emphasis">
            {tVenue('slots.minutes', { minutes: selection.minutes })}
          </dd>
          <dt className="text-content-muted">{t('price')}</dt>
          <dd className="text-content-emphasis tabular-nums">{price}</dd>
          <dt className="text-content-muted">{t('payment')}</dt>
          <dd className="text-content-emphasis">{t('payAtClub')}</dd>
        </dl>

        {canCancelOnline ? (
          <InlineNotice variant="info" title={t('cancelUntilTitle')}>
            {t('cancelUntil', { deadline: at(deadline, true) })}
          </InlineNotice>
        ) : (
          <InlineNotice variant="warning" title={t('noOnlineCancelTitle')}>
            {t('noOnlineCancel', { hours: cutoffHours })}
          </InlineNotice>
        )}

        {error && <Refusal error={error} signInPath={signInPath} />}
      </Sheet.Body>
      <Sheet.Actions align="between">
        {refusal === 'gone' ? (
          <Button type="button" variant="primary" onClick={onPickAnother}>
            {t('pickAnother')}
          </Button>
        ) : (
          <>
            <Sheet.Close asChild>
              <Button type="button" variant="secondary">
                {t('back')}
              </Button>
            </Sheet.Close>
            {refusal !== 'final' && refusal !== 'signIn' && (
              <Button
                type="button"
                variant="primary"
                onClick={() => void confirm()}
                loading={booking.isMutating || leaving}
                disabled={booking.isMutating || leaving}
              >
                {t('confirm')}
              </Button>
            )}
          </>
        )}
      </Sheet.Actions>
    </Sheet>
  );
}

function Refusal({ error, signInPath }: { error: ApiClientError; signInPath: string }) {
  const t = useTranslations('venue.sheet');

  switch (error.code) {
    case 'SLOT_TAKEN':
      return (
        <InlineNotice variant="warning" title={t('error.slotTakenTitle')}>
          {t('error.slotTaken')}
        </InlineNotice>
      );
    case 'SLOT_NOT_BOOKABLE':
      return (
        <InlineNotice variant="warning" title={t('error.slotNotBookableTitle')}>
          {t('error.slotNotBookable')}
        </InlineNotice>
      );
    // The server writes this one in the player's own language (#354): it
    // names their no-show count and says to contact the club.
    case 'NO_SHOW_BLOCKED':
      return (
        <InlineNotice variant="error" title={t('error.noShowBlockedTitle')}>
          {error.message}
        </InlineNotice>
      );
    case 'BOOKING_LIMIT_REACHED': {
      const numbers = limitDetails(error.details);
      return (
        <InlineNotice variant="error" title={t('error.limitTitle')}>
          {numbers ? t('error.limit', numbers) : error.message}
        </InlineNotice>
      );
    }
    case 'PLAYER_ACCOUNT_REQUIRED':
      return (
        <InlineNotice variant="error" title={t('error.accountTitle')}>
          {error.message}
        </InlineNotice>
      );
    default:
      if (error.status === 401) {
        return (
          <InlineNotice variant="warning" title={t('error.signedOutTitle')}>
            <p>{t('error.signedOut')}</p>
            <Link
              href={signInPath}
              className={cn(buttonVariants({ variant: 'secondary' }), 'mt-2')}
            >
              {t('signIn')}
            </Link>
          </InlineNotice>
        );
      }
      return (
        <InlineNotice variant="error" title={t('error.failedTitle')}>
          {t('error.failed')}
        </InlineNotice>
      );
  }
}
