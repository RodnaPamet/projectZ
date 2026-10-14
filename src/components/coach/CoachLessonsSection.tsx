'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import type { MyLessonDto } from '@/app/api/v1/_lib/coach-dto';
import { ProfileSection, PROFILE_ROW } from '@/components/profile/ProfileSection';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Caption } from '@/components/ui/typography';
import { KEYS, type V1Page } from '@/lib/data/keys';
import { needsSkeleton, useV1SWRInfinite } from '@/lib/data/use-v1-swr';

/**
 * «Уроци» on a coach's own page (#548): the lessons they teach, at every
 * club, on `GET /api/v1/me/coach-lessons`. Upcoming first, soonest on top;
 * the past ones on their own tab, read when it is opened.
 *
 * Each says when, where and on which court, who booked it, and the coach's
 * own fee. The times are the VENUE's: a coach checking tomorrow's lessons from
 * anywhere is shown the hour they have to be on court.
 *
 * The page seeds the upcoming list from the server with the endpoint's own
 * mapper, so it paints with the HTML and is revalidated once after.
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

export function CoachLessonsSection({ seed }: { seed: V1Page<MyLessonDto> }) {
  const t = useTranslations('coachLessons');
  const tStatus = useTranslations('myBookings.status');
  const tSports = useTranslations('sports');
  const format = useFormatter();
  const [when, setWhen] = useState<When>('upcoming');

  const { data, error, size, setSize, isLoading, isValidating, mutate } =
    useV1SWRInfinite<MyLessonDto>(
      LESSON_KEYS[when],
      // Not the other tab's lessons while this one loads: upcoming lessons
      // under «Минали» would be read as lessons that have happened.
      { keepPreviousData: false, ...(when === 'upcoming' ? { fallbackData: [seed] } : {}) },
    );

  const lessons = data?.flatMap((p) => p.items) ?? [];
  const more = data?.at(-1)?.nextCursor != null;
  const loading = needsSkeleton({ isLoading, data });

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
          selectAction={(v) => setWhen(v as When)}
        />
      </div>

      {loading ? (
        <div className={PROFILE_ROW} aria-busy="true">
          <span className="text-content-muted text-sm">{t('loading')}</span>
        </div>
      ) : error && lessons.length === 0 ? (
        <div className={PROFILE_ROW} data-testid="coach-lessons-error">
          <span className="text-content-muted text-sm">{t('error')}</span>
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
          const timeZone = l.venue.timezone;
          const day = format.dateTime(new Date(l.startTs), {
            weekday: 'short',
            day: 'numeric',
            month: 'long',
            timeZone,
          });
          const hour = (iso: string) =>
            format.dateTime(new Date(iso), {
              hour: '2-digit',
              minute: '2-digit',
              hourCycle: 'h23',
              timeZone,
            });
          const tone = ENDED_TONE[l.status as keyof typeof ENDED_TONE];
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
                  {t('when', { day, start: hour(l.startTs), end: hour(l.endTs) })}
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
                {l.player ? t('player', { name: l.player }) : t('noPlayer')}
              </Caption>
              <Caption>
                {t('fee', {
                  price: format.number(l.coachFeeCents / 100, {
                    style: 'currency',
                    currency: l.currency,
                  }),
                })}
              </Caption>
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
    </ProfileSection>
  );
}
