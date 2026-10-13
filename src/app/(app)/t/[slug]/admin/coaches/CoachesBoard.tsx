'use client';

import dynamic from 'next/dynamic';
import { useFormatter, useTranslations } from 'next-intl';
import { startTransition, useActionState, useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';

import {
  answerCoachRequestAction,
  endCoachLinkAction,
  inviteCoachAction,
  type CoachActionError,
} from './actions';

// Loaded when somebody is about to end a coach: the page does not carry it.
const ConfirmDialog = dynamic(() =>
  import('@/components/ui/confirm-dialog').then((m) => m.ConfirmDialog),
);

/** One coach at one of the club's venues, as the page hands it over. */
export interface ClubCoachRow {
  id: string;
  status: 'REQUESTED' | 'ACTIVE';
  venueName: string;
  name: string | null;
  approved: boolean;
  bio: string | null;
  qualifications: string | null;
  sports: Array<{ sport: string; levelMin: number; levelMax: number }>;
  hourlyRateCents: number | null;
  groupRateCents: number | null;
  currency: string;
  lessonMinutes: number[];
  cancelCutoffHours: number;
  hours: Array<{ dayOfWeek: number; open: string; close: string }>;
  missing: string[];
}

/**
 * «Треньори» in the club admin (#546): the requests waiting for an answer,
 * the coaches teaching here, and an invitation by email.
 *
 * The club decides who teaches at its venues; what a coach charges and when
 * they work is the coach's (owner decisions 2, 5, 6, 14), so the terms are
 * shown here and not edited. Each action goes to the server, which decides,
 * and the page is drawn again from what it holds: there is nothing optimistic
 * about taking a person on or letting them go.
 */
export function CoachesBoard({ slug, coaches }: { slug: string; coaches: ClubCoachRow[] }) {
  const t = useTranslations('admin.coaches');
  const requests = coaches.filter((c) => c.status === 'REQUESTED');
  const active = coaches.filter((c) => c.status === 'ACTIVE');

  const [failed, act, pending] = useActionState(
    async (
      _prev: { id: string; error: CoachActionError } | null,
      a: { id: string; what: 'accept' | 'decline' | 'end' },
    ) => {
      const res =
        a.what === 'end'
          ? await endCoachLinkAction(slug, a.id)
          : await answerCoachRequestAction(slug, a.id, a.what === 'accept');
      return res.ok ? null : { id: a.id, error: res.error };
    },
    null,
  );
  const [ending, setEnding] = useState<ClubCoachRow | null>(null);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="grid gap-8">
      <InviteForm slug={slug} />

      {/* An error about a row that has since left the list (answered elsewhere). */}
      {failed && !coaches.some((c) => c.id === failed.id) ? (
        <InlineNotice variant="warning" data-testid="club-coaches-stale">
          {t(`error.${failed.error}`)}
        </InlineNotice>
      ) : null}

      <section className="grid gap-3" data-testid="club-coach-requests">
        <Heading level={2} className="text-base">
          {t('requests.title')}
        </Heading>
        {requests.length === 0 ? (
          <p className="text-content-muted text-sm">{t('requests.none')}</p>
        ) : (
          <ul className="grid gap-4">
            {requests.map((c) => (
              <CoachCard key={c.id} coach={c} error={failed?.id === c.id ? failed.error : null}>
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => startTransition(() => act({ id: c.id, what: 'accept' }))}
                  data-testid="club-coach-accept"
                >
                  {t('action.accept')}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => startTransition(() => act({ id: c.id, what: 'decline' }))}
                  data-testid="club-coach-decline"
                >
                  {t('action.decline')}
                </Button>
              </CoachCard>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-3" data-testid="club-coaches-active">
        <Heading level={2} className="text-base">
          {t('active.title')}
        </Heading>
        {active.length === 0 ? (
          <EmptyState title={t('active.none')} description={t('active.noneHint')} />
        ) : (
          <ul className="grid gap-4">
            {active.map((c) => (
              <CoachCard key={c.id} coach={c} error={failed?.id === c.id ? failed.error : null}>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={pending}
                  onClick={() => {
                    setEnding(c);
                    setConfirming(true);
                  }}
                  data-testid="club-coach-end"
                >
                  {t('action.end')}
                </Button>
              </CoachCard>
            ))}
          </ul>
        )}
      </section>

      {ending && (
        <ConfirmDialog
          showModal={confirming}
          setShowModal={setConfirming}
          tone="danger"
          title={t('end.title', { name: ending.name ?? t('noName'), venue: ending.venueName })}
          description={t('end.confirm')}
          confirmLabel={t('action.end')}
          cancelLabel={t('action.cancel')}
          onConfirm={() => startTransition(() => act({ id: ending.id, what: 'end' }))}
        />
      )}
    </div>
  );
}

function CoachCard({
  coach,
  error,
  children,
}: {
  coach: ClubCoachRow;
  error: CoachActionError | null;
  children: React.ReactNode;
}) {
  const t = useTranslations('admin.coaches');
  const tSports = useTranslations('sports');
  const tDay = useTranslations('common.calendar.weekdayShort');
  const format = useFormatter();

  const money = (cents: number) =>
    format.number(cents / 100, { style: 'currency', currency: coach.currency });
  // Monday first, as the calendar here is read; 0 is Sunday in the data.
  const days = [1, 2, 3, 4, 5, 6, 0]
    .map((d) => ({ d, stretches: coach.hours.filter((h) => h.dayOfWeek === d) }))
    .filter((x) => x.stretches.length > 0);

  return (
    <li
      className="border-border-subtle bg-bg-default rounded-lg border p-4"
      data-testid="club-coach-card"
      data-coach-link={coach.id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-content-emphasis font-medium">{coach.name?.trim() || t('noName')}</p>
        <p className="text-content-muted text-sm">{coach.venueName}</p>
      </div>
      {!coach.approved ? (
        <div className="mt-2">
          <StatusBadge variant="warning">{t('notApproved')}</StatusBadge>
          <p className="text-content-muted mt-1 text-sm">{t('notApprovedHint')}</p>
        </div>
      ) : null}

      <dl className="mt-3 grid gap-3 text-sm">
        {coach.sports.length > 0 ? (
          <div>
            <dt className="text-content-muted text-xs font-medium">{t('field.sports')}</dt>
            <dd className="text-content-default">
              {coach.sports
                .map((s) =>
                  s.levelMin === s.levelMax
                    ? t('sportOne', { sport: tSports(s.sport as never), level: s.levelMin })
                    : t('sportRange', {
                        sport: tSports(s.sport as never),
                        min: s.levelMin,
                        max: s.levelMax,
                      }),
                )
                .join(' · ')}
            </dd>
          </div>
        ) : null}
        {coach.bio ? (
          <div>
            <dt className="text-content-muted text-xs font-medium">{t('field.bio')}</dt>
            <dd className="text-content-default whitespace-pre-wrap">{coach.bio}</dd>
          </div>
        ) : null}
        {coach.qualifications ? (
          <div>
            <dt className="text-content-muted text-xs font-medium">{t('field.qualifications')}</dt>
            <dd className="text-content-default whitespace-pre-wrap">{coach.qualifications}</dd>
          </div>
        ) : null}

        {coach.status === 'ACTIVE' ? (
          <>
            <div>
              <dt className="text-content-muted text-xs font-medium">{t('field.rates')}</dt>
              <dd className="text-content-default" data-testid="club-coach-rates">
                {coach.hourlyRateCents === null
                  ? t('notSet')
                  : coach.groupRateCents === null
                    ? t('rate', { hourly: money(coach.hourlyRateCents) })
                    : t('rateWithGroup', {
                        hourly: money(coach.hourlyRateCents),
                        group: money(coach.groupRateCents),
                      })}
              </dd>
            </div>
            <div>
              <dt className="text-content-muted text-xs font-medium">{t('field.lessons')}</dt>
              <dd className="text-content-default">
                {coach.lessonMinutes.length === 0
                  ? t('notSet')
                  : t('lessons', {
                      lengths: coach.lessonMinutes.join(', '),
                      cutoff: coach.cancelCutoffHours,
                    })}
              </dd>
            </div>
            <div>
              <dt className="text-content-muted text-xs font-medium">{t('field.hours')}</dt>
              <dd className="text-content-default" data-testid="club-coach-hours">
                {days.length === 0
                  ? t('notSet')
                  : days
                      .map(
                        ({ d, stretches }) =>
                          `${tDay(String(d) as never)} ${stretches
                            .map((h) => `${h.open}–${h.close}`)
                            .join(', ')}`,
                      )
                      .join(' · ')}
              </dd>
            </div>
            {coach.missing.length > 0 ? (
              <p className="text-content-muted" data-testid="club-coach-missing">
                {t('missing')}
              </p>
            ) : null}
          </>
        ) : null}
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">{children}</div>
      {error ? (
        <InlineNotice variant="error" className="mt-3">
          {t(`error.${error}`)}
        </InlineNotice>
      ) : null}
    </li>
  );
}

function InviteForm({ slug }: { slug: string }) {
  const t = useTranslations('admin.coaches');
  const id = useId();
  const [state, formAction, pending] = useActionState(inviteCoachAction.bind(null, slug), null);

  return (
    <form action={formAction} className="grid gap-1.5 sm:max-w-xl" data-testid="club-coach-invite">
      <Label htmlFor={`${id}-email`}>{t('invite.label')}</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={`${id}-email`}
          name="email"
          type="email"
          autoComplete="off"
          required
          className="min-w-0 flex-1"
        />
        <Button type="submit" loading={pending} disabled={pending}>
          {t('invite.send')}
        </Button>
      </div>
      <p className="text-content-muted text-sm">{t('invite.hint')}</p>
      {state?.ok ? <InlineNotice variant="success">{t('invite.sent')}</InlineNotice> : null}
      {state && !state.ok ? (
        <InlineNotice variant="error">{t(`error.${state.error}`)}</InlineNotice>
      ) : null}
    </form>
  );
}
