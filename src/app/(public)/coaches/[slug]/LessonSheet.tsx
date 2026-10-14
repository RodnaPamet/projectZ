'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { BookedLessonDto } from '@/app/api/v1/_lib/coach-dto';
import type { BookingDto } from '@/app/api/v1/_lib/dto';
import { PhoneRequiredNotice } from '@/components/phone/PhoneRequiredNotice';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Sheet } from '@/components/ui/sheet';
import { Caption } from '@/components/ui/typography';
import { cn } from '@/lib/cn';
import type { ApiClientError } from '@/lib/data/errors';
import { isApiClientError } from '@/lib/data/errors';
import type { useV1Mutation } from '@/lib/data/use-v1-mutation';

/** The lesson the player picked: one coach at one venue, one start, one length. */
export interface LessonSelection {
  linkId: string;
  sport: string;
  minutes: number;
  startTs: string;
  endTs: string;
  /** The court the lesson would be on; the booking may land on another one. */
  courtName: string;
  coachFeeCents: number;
  courtPriceCents: number;
  totalCents: number;
  currency: string;
}

export type LessonBookingDto = BookingDto & { lesson: BookedLessonDto };

type LessonMutation = ReturnType<typeof useV1Mutation<LessonSelection, LessonBookingDto>>;

const HOUR_MS = 3_600_000;

/**
 * How the sheet answers a refused lesson.
 *
 *   gone    the time can no longer be had as it was shown: the coach was
 *           booked (409 COACH_TAKEN), no court is left (409 SLOT_TAKEN), the
 *           coach no longer teaches then (409 LESSON_TIME_NOT_OFFERED), it has
 *           started (400 SLOT_NOT_BOOKABLE), or it would cost more than shown
 *           (409 LESSON_PRICE_CHANGED). The times are refreshed and the player
 *           picks again.
 *   final   the player may not book this, and retrying will not change it:
 *           every refusal a court booking has, a coach booking with themself,
 *           and a coach who can no longer be booked there.
 *   signIn  the session ended (401): sign in and come back to this lesson.
 *   retry   anything else, a dropped connection included. Confirming again
 *           re-sends the SAME Idempotency-Key, so a lesson that did land is
 *           returned rather than booked twice.
 */
export type LessonRefusal = 'gone' | 'final' | 'signIn' | 'retry';

export function lessonRefusal(err: ApiClientError): LessonRefusal {
  switch (err.code) {
    case 'COACH_TAKEN':
    case 'SLOT_TAKEN':
    case 'SLOT_NOT_BOOKABLE':
    case 'LESSON_TIME_NOT_OFFERED':
    case 'LESSON_PRICE_CHANGED':
      return 'gone';
    case 'NO_SHOW_BLOCKED':
    case 'BOOKING_LIMIT_REACHED':
    case 'PLAYER_ACCOUNT_REQUIRED':
    case 'PHONE_REQUIRED':
    case 'OWN_LESSON':
    case 'COACH_NOT_BOOKABLE':
    case 'LESSON_LENGTH_NOT_OFFERED':
      return 'final';
    default:
      return err.status === 401 ? 'signIn' : 'retry';
  }
}

function numbers(details: unknown, ...keys: string[]): Record<string, number> | null {
  if (!details || typeof details !== 'object') return null;
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = (details as Record<string, unknown>)[k];
    if (typeof v !== 'number') return null;
    out[k] = v;
  }
  return out;
}

/**
 * The confirmation sheet for a lesson (#548): the coach, where and when, the
 * court, and the price in its two parts and in all, paid at the club; then
 * one POST. One tap, one lesson, by the same means as the court booking's
 * sheet (`BookingSheet`): a ref against the double tap, and a failed attempt
 * re-sent with its own Idempotency-Key.
 */
export function LessonSheet({
  open,
  onOpenChange,
  coachName,
  venueName,
  timezone,
  cutoffHours,
  selection,
  booking,
  now,
  returnPath,
  onBooked,
  onGone,
  onPickAnother,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  coachName: string;
  venueName: string;
  timezone: string;
  /** The stricter of the club's cutoff and the coach's, as the times say it. */
  cutoffHours: number;
  selection: LessonSelection;
  booking: LessonMutation;
  now: number;
  /** This page, this venue, day and time, with the sheet open. */
  returnPath: string;
  onBooked: () => void;
  onGone: () => void;
  onPickAnother: () => void;
}) {
  const t = useTranslations('coaches.lesson.sheet');
  const tVenue = useTranslations('venue');
  const tSports = useTranslations('sports');
  const format = useFormatter();
  const busy = useRef(false);
  const failedFor = useRef<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const selectionKey = `${selection.linkId}|${selection.sport}|${selection.startTs}|${selection.minutes}`;

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
  const money = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: selection.currency });

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
      if (isApiClientError(err) && lessonRefusal(err) === 'gone') onGone();
    } finally {
      busy.current = false;
    }
  }

  const error = booking.error;
  const refusal = error ? lessonRefusal(error) : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('title')} description={coachName}>
      <Sheet.Header title={t('title')} description={coachName} />
      {/* On a phone the details are taller than the sheet and its body
          scrolls. A region that scrolls must be reachable from the keyboard,
          and nothing inside this one takes focus (the buttons are in the
          actions row), so the body itself does, under a name. */}
      <Sheet.Body
        className="flex flex-col gap-4"
        data-testid="lesson-sheet"
        role="group"
        aria-label={t('details')}
        tabIndex={0}
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-content-muted">{t('coach')}</dt>
          <dd className="text-content-emphasis">{coachName}</dd>
          <dt className="text-content-muted">{t('venue')}</dt>
          <dd className="text-content-emphasis">{venueName}</dd>
          <dt className="text-content-muted">{t('court')}</dt>
          <dd className="text-content-emphasis">
            {t('courtOf', { court: selection.courtName, sport: tSports(selection.sport as never) })}
          </dd>
          <dt className="text-content-muted">{tVenue('sheet.date')}</dt>
          <dd className="text-content-emphasis">{day}</dd>
          <dt className="text-content-muted">{tVenue('sheet.time')}</dt>
          <dd className="text-content-emphasis tabular-nums">
            {tVenue('sheet.timeRange', {
              start: at(selection.startTs, false),
              end: at(selection.endTs, false),
            })}
          </dd>
          <dt className="text-content-muted">{tVenue('sheet.duration')}</dt>
          <dd className="text-content-emphasis">
            {tVenue('slots.minutes', { minutes: selection.minutes })}
          </dd>
        </dl>

        <dl
          className="border-border-subtle grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 border-t pt-4 text-sm"
          data-testid="lesson-sheet-price"
        >
          <dt className="text-content-muted">{t('coachFee')}</dt>
          <dd className="text-content-emphasis text-right tabular-nums">
            {money(selection.coachFeeCents)}
          </dd>
          <dt className="text-content-muted">{t('courtPrice')}</dt>
          <dd className="text-content-emphasis text-right tabular-nums">
            {money(selection.courtPriceCents)}
          </dd>
          <dt className="text-content-emphasis font-medium">{t('total')}</dt>
          <dd
            className="text-content-emphasis text-right font-medium tabular-nums"
            data-testid="lesson-sheet-total"
          >
            {money(selection.totalCents)}
          </dd>
        </dl>
        <Caption>{t('payAtClub')}</Caption>

        {canCancelOnline ? (
          <InlineNotice variant="info" title={tVenue('sheet.cancelUntilTitle')}>
            {tVenue('sheet.cancelUntil', { deadline: at(deadline, true) })}
          </InlineNotice>
        ) : (
          <InlineNotice variant="warning" title={tVenue('sheet.noOnlineCancelTitle')}>
            {t('noOnlineCancel', { hours: cutoffHours })}
          </InlineNotice>
        )}

        {error && <Refusal error={error} returnPath={returnPath} currency={selection.currency} />}
      </Sheet.Body>
      <Sheet.Actions align="between">
        {refusal === 'gone' ? (
          <Button type="button" variant="primary" onClick={onPickAnother}>
            {tVenue('sheet.pickAnother')}
          </Button>
        ) : (
          <>
            <Sheet.Close asChild>
              <Button type="button" variant="secondary">
                {tVenue('sheet.back')}
              </Button>
            </Sheet.Close>
            {refusal !== 'final' && refusal !== 'signIn' && (
              <Button
                type="button"
                variant="primary"
                onClick={() => void confirm()}
                loading={booking.isMutating || leaving}
                disabled={booking.isMutating || leaving}
                data-testid="lesson-sheet-confirm"
              >
                {tVenue('sheet.confirm')}
              </Button>
            )}
          </>
        )}
      </Sheet.Actions>
    </Sheet>
  );
}

function Refusal({
  error,
  returnPath,
  currency,
}: {
  error: ApiClientError;
  returnPath: string;
  currency: string;
}) {
  const t = useTranslations('coaches.lesson.sheet.error');
  const tVenue = useTranslations('venue.sheet');
  const format = useFormatter();

  switch (error.code) {
    case 'COACH_TAKEN':
      return (
        <InlineNotice variant="warning" title={t('coachTakenTitle')}>
          {t('coachTaken')}
        </InlineNotice>
      );
    case 'SLOT_TAKEN':
      return (
        <InlineNotice variant="warning" title={t('noCourtTitle')}>
          {t('noCourt')}
        </InlineNotice>
      );
    case 'LESSON_TIME_NOT_OFFERED':
    case 'SLOT_NOT_BOOKABLE':
      return (
        <InlineNotice variant="warning" title={t('notOfferedTitle')}>
          {t('notOffered')}
        </InlineNotice>
      );
    case 'LESSON_PRICE_CHANGED': {
      const now = numbers(error.details, 'totalCents');
      return (
        <InlineNotice variant="warning" title={t('priceChangedTitle')}>
          {now
            ? t('priceChanged', {
                price: format.number(now.totalCents! / 100, { style: 'currency', currency }),
              })
            : t('priceChangedNoPrice')}
        </InlineNotice>
      );
    }
    case 'COACH_NOT_BOOKABLE':
    case 'LESSON_LENGTH_NOT_OFFERED':
      return (
        <InlineNotice variant="error" title={t('notBookableTitle')}>
          {t('notBookable')}
        </InlineNotice>
      );
    case 'OWN_LESSON':
      return (
        <InlineNotice variant="error" title={t('notBookableTitle')}>
          {t('ownLesson')}
        </InlineNotice>
      );
    // The server writes these two in the player's own language (#354, #263).
    case 'NO_SHOW_BLOCKED':
      return (
        <InlineNotice variant="error" title={tVenue('error.noShowBlockedTitle')}>
          {error.message}
        </InlineNotice>
      );
    case 'PLAYER_ACCOUNT_REQUIRED':
      return (
        <InlineNotice variant="error" title={tVenue('error.accountTitle')}>
          {error.message}
        </InlineNotice>
      );
    case 'BOOKING_LIMIT_REACHED': {
      const cap = numbers(error.details, 'limit', 'upcoming');
      return (
        <InlineNotice variant="error" title={tVenue('error.limitTitle')}>
          {cap
            ? tVenue('error.limit', { limit: cap.limit!, upcoming: cap.upcoming! })
            : error.message}
        </InlineNotice>
      );
    }
    case 'PHONE_REQUIRED':
      return <PhoneRequiredNotice next={returnPath} />;
    default:
      if (error.status === 401) {
        return (
          <InlineNotice variant="warning" title={tVenue('error.signedOutTitle')}>
            <p>{t('signedOut')}</p>
            <Link
              href={`/login?next=${encodeURIComponent(returnPath)}`}
              className={cn(buttonVariants({ variant: 'secondary' }), 'mt-2')}
            >
              {tVenue('signIn')}
            </Link>
          </InlineNotice>
        );
      }
      return (
        <InlineNotice variant="error" title={t('failedTitle')}>
          {t('failed')}
        </InlineNotice>
      );
  }
}
