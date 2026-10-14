'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { MyLessonDto } from '@/app/api/v1/_lib/coach-dto';
import { ProfileSection, PROFILE_ROW } from '@/components/profile/ProfileSection';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption } from '@/components/ui/typography';
import { isApiClientError } from '@/lib/data/errors';
import { KEYS, V1, type V1Page } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { needsSkeleton, useV1SWRInfinite } from '@/lib/data/use-v1-swr';

// The dialog is loaded when a coach first asks to cancel or to mark a no-show.
const ConfirmDialog = dynamic(() =>
  import('@/components/ui/confirm-dialog').then((m) => m.ConfirmDialog),
);

/**
 * «Уроци» on a coach's own page (#548, #549): the lessons they teach, at
 * every club, on `GET /api/v1/me/coach-lessons`. Upcoming first, soonest on
 * top; the past ones on their own tab, read when it is opened.
 *
 * Each says when, where and on which court, who booked it, and the coach's
 * own fee. Of the player the coach is shown what owner decision 12 allows:
 * the name, the level they declared in this sport, and, while the lesson is
 * still to come, the phone number they confirmed, to call about it.
 *
 * A coach can do two things to a lesson (decisions 8 and 11): cancel it,
 * until it starts, which releases the court and tells the player; and, once
 * it has started, record that the player did not come, which counts at the
 * club as a no-show the desk marks. Both ask first, and the server decides
 * again whatever this page thought.
 *
 * The times are the VENUE's: a coach checking tomorrow's lessons from
 * anywhere is shown the hour they have to be on court.
 */

type When = 'upcoming' | 'past';

// One key function per tab, made once: SWR compares them by identity.
const LESSON_KEYS = {
  upcoming: KEYS.myCoachLessons({ when: 'upcoming' }),
  past: KEYS.myCoachLessons({ when: 'past' }),
} as const;

/** What a lesson that is no longer on ended as; one still on has no badge. */
const ENDED_TONE = {
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
  COMPLETED: 'success',
  NO_SHOW: 'warning',
} as const;

export type LessonErrorKey =
  'started' | 'notStarted' | 'alreadyNoShow' | 'reviewed' | 'notAttendable' | 'gone' | 'failed';

/** Which sentence a refused cancel or no-show gets. */
export function lessonErrorKey(err: unknown): LessonErrorKey {
  if (!isApiClientError(err)) return 'failed';
  if (err.code === 'LESSON_STARTED') return 'started';
  if (err.code === 'LESSON_NOT_FOUND') return 'gone';
  if (err.code === 'BOOKING_NOT_CANCELLABLE') return 'notAttendable';
  if (err.code === 'NO_SHOW_REFUSED') {
    const reason = (err.details as { reason?: unknown } | undefined)?.reason;
    if (reason === 'NOT_STARTED') return 'notStarted';
    if (reason === 'ALREADY_NO_SHOW') return 'alreadyNoShow';
    if (reason === 'REVIEWED') return 'reviewed';
    return 'notAttendable';
  }
  return 'failed';
}

const MINUTE_MS = 60_000;

export function CoachLessonsSection({
  seed,
  renderedAt,
}: {
  seed: V1Page<MyLessonDto>;
  /** The server's clock at render, so the first paint agrees with the HTML. */
  renderedAt: string;
}) {
  const t = useTranslations('coachLessons');
  const tStatus = useTranslations('myBookings.status');
  const tSports = useTranslations('sports');
  const format = useFormatter();
  const [when, setWhen] = useState<When>('upcoming');
  const [now, setNow] = useState(() => Date.parse(renderedAt));
  const [asking, setAsking] = useState<{ lesson: MyLessonDto; act: 'cancel' | 'noShow' } | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<LessonErrorKey | null>(null);

  // Which button a lesson has depends on whether it has started.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(id);
  }, []);

  const {
    data,
    error: listError,
    size,
    setSize,
    isLoading,
    isValidating,
    mutate,
  } = useV1SWRInfinite<MyLessonDto>(
    LESSON_KEYS[when],
    // Not the other tab's lessons while this one loads: upcoming lessons
    // under «Минали» would be read as lessons that have happened.
    { keepPreviousData: false, ...(when === 'upcoming' ? { fallbackData: [seed] } : {}) },
  );

  // Either act moves the lesson between the two lists, so both are read again.
  const related = { infinite: [LESSON_KEYS.upcoming, LESSON_KEYS.past] };
  const cancel = useV1Mutation<string, unknown>({ url: (id) => V1.cancelMyLesson(id), related });
  const noShow = useV1Mutation<string, unknown>({ url: (id) => V1.lessonNoShow(id), related });
  const busy = cancel.isMutating || noShow.isMutating;

  async function confirm() {
    if (!asking) return;
    setError(null);
    try {
      await (asking.act === 'cancel' ? cancel : noShow).trigger(asking.lesson.id);
    } catch (err) {
      setError(lessonErrorKey(err));
      // What the server knows now, whatever this page thought.
      void mutate();
    }
  }

  const lessons = data?.flatMap((p) => p.items) ?? [];
  const more = data?.at(-1)?.nextCursor != null;
  const loading = needsSkeleton({ isLoading, data });

  const dayOf = (l: MyLessonDto) =>
    format.dateTime(new Date(l.startTs), {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      timeZone: l.venue.timezone,
    });
  const hour = (iso: string, timeZone: string) =>
    format.dateTime(new Date(iso), {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    });

  return (
    <ProfileSection title={t('title')} testId="coach-lessons">
      <div className="px-4 py-3">
        <ToggleGroup
          size="sm"
          ariaLabel={t('tabsLabel')}
          options={[
            { value: 'upcoming', label: t('tabs.upcoming') },
            { value: 'past', label: t('tabs.past') },
          ]}
          selected={when}
          selectAction={(v) => {
            setWhen(v as When);
            setError(null);
          }}
        />
      </div>

      {error ? (
        <div className="px-4 py-3">
          <InlineNotice variant="error" data-testid="coach-lesson-error">
            {t(`error.${error}`)}
          </InlineNotice>
        </div>
      ) : null}

      {loading ? (
        <div className={PROFILE_ROW} aria-busy="true">
          <span className="text-content-muted text-sm">{t('loading')}</span>
        </div>
      ) : listError && lessons.length === 0 ? (
        <div className={PROFILE_ROW} data-testid="coach-lessons-error">
          <span className="text-content-muted text-sm">{t('error.list')}</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void mutate()}
            text={t('retry')}
          />
        </div>
      ) : lessons.length === 0 ? (
        <div className={PROFILE_ROW} data-testid="coach-lessons-none">
          <span className="text-content-muted text-sm">
            {when === 'upcoming' ? t('noneUpcoming') : t('nonePast')}
          </span>
        </div>
      ) : (
        lessons.map((l) => {
          const tone = ENDED_TONE[l.status as keyof typeof ENDED_TONE];
          const started = Date.parse(l.startTs) <= now;
          const on = l.status === 'CONFIRMED' || l.status === 'PENDING';
          // Until the start it can be cancelled; from the start on, the one
          // thing left to say is whether the player came.
          const canCancel = on && !started;
          const canNoShow = started && (l.status === 'CONFIRMED' || l.status === 'COMPLETED');
          return (
            <div
              key={l.id}
              className="gap-tight grid px-4 py-3"
              data-testid="coach-lesson"
              data-booking={l.bookingId}
              data-status={l.status}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-content-default text-sm font-medium tabular-nums">
                  {t('when', {
                    day: dayOf(l),
                    start: hour(l.startTs, l.venue.timezone),
                    end: hour(l.endTs, l.venue.timezone),
                  })}
                </span>
                {tone ? (
                  <StatusBadge variant={tone}>{tStatus(l.status as never)}</StatusBadge>
                ) : null}
              </div>
              <Caption>
                {t('where', {
                  venue: l.venue.name,
                  court: l.court.name,
                  sport: tSports(l.court.sport as never),
                })}
              </Caption>
              <Caption data-testid="coach-lesson-player">
                {l.player
                  ? l.player.level === null
                    ? t('player', { name: l.player.name ?? t('unnamed') })
                    : t('playerLevel', {
                        name: l.player.name ?? t('unnamed'),
                        level: l.player.level,
                      })
                  : t('noPlayer')}
                {l.players > 1 ? ` · ${t('group', { count: l.players })}` : ''}
              </Caption>
              {l.player?.phone ? (
                <Caption>
                  {/* Dialled as it is; read out digit by digit, not as a number. */}
                  <a
                    href={`tel:${l.player.phone}`}
                    className="text-content-default underline-offset-4 hover:underline"
                    data-testid="coach-lesson-phone"
                  >
                    {l.player.phone}
                  </a>
                </Caption>
              ) : null}
              <Caption>
                {t('fee', {
                  price: format.number(l.coachFeeCents / 100, {
                    style: 'currency',
                    currency: l.currency,
                  }),
                })}
              </Caption>
              {canCancel || canNoShow ? (
                <div className="gap-tight flex flex-wrap pt-1">
                  {canCancel ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setAsking({ lesson: l, act: 'cancel' });
                        setOpen(true);
                      }}
                      data-testid="coach-lesson-cancel"
                      text={t('cancel.button')}
                    />
                  ) : null}
                  {canNoShow ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setAsking({ lesson: l, act: 'noShow' });
                        setOpen(true);
                      }}
                      data-testid="coach-lesson-no-show"
                      text={t('noShow.button')}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })
      )}

      {more ? (
        <div className={PROFILE_ROW}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void setSize(size + 1)}
            loading={isValidating}
            disabled={isValidating}
            text={t('more')}
          />
        </div>
      ) : null}

      {asking ? (
        <ConfirmDialog
          showModal={open}
          setShowModal={setOpen}
          tone="danger"
          title={asking.act === 'cancel' ? t('cancel.title') : t('noShow.title')}
          description={
            asking.act === 'cancel'
              ? t('cancel.description', {
                  day: dayOf(asking.lesson),
                  time: hour(asking.lesson.startTs, asking.lesson.venue.timezone),
                  venue: asking.lesson.venue.name,
                })
              : t('noShow.description', {
                  name: asking.lesson.player?.name ?? t('unnamed'),
                  club: asking.lesson.club,
                })
          }
          confirmLabel={asking.act === 'cancel' ? t('cancel.yes') : t('noShow.yes')}
          cancelLabel={t('keep')}
          onConfirm={() => void confirm()}
        />
      ) : null}
    </ProfileSection>
  );
}
