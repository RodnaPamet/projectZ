'use client';

import type { TenantStatus } from '@prisma/client';
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { isApiClientError } from '@/lib/data/errors';
import { KEYS, V1, type V1Page } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { needsSkeleton, useV1SWR } from '@/lib/data/use-v1-swr';

import { StepUpForm } from '../StepUpForm';

/**
 * Every club and its status, and the controls that take one offline (#254).
 *
 * ═══ READS ARE RECORDS ═══
 *
 * The list is a PLATFORM_TENANT_LIST read audited with the reason stated
 * here: nothing is read until a reason is given, and nothing re-reads on its
 * own (`audited`), as on /platform/fees.
 *
 * ═══ SUSPEND, CLOSE, REOPEN ═══
 *
 * Only with TENANT_SUSPEND (`canChange` only HIDES the controls; the binding
 * decides). Each change asks for its own reason, which is its audit reason,
 * and needs a step-up from the last 15 minutes, so STEP_UP_REQUIRED shows the
 * code form. The owner's rules, from the use case: going offline cancels the
 * club's upcoming bookings with notice, staff keep read-only access, a
 * reopened club does not get its cancelled bookings back, and CLOSED is final.
 */

const MIN_REASON = 12;

interface ClubRow {
  id: string;
  slug: string;
  name: string;
  city: string | null;
  status: TenantStatus;
}

type Target = 'SUSPENDED' | 'CLOSED' | 'ACTIVE';

interface StatusAnswer {
  from: TenantStatus;
  to: TenantStatus;
  bookings: { cancelled: number; failed: number; remaining: number };
}

const KNOWN_ERRORS = new Set([
  'PLATFORM_AUTHORITY_REQUIRED',
  'PLATFORM_CAPABILITY_REQUIRED',
  'REASON_REQUIRED',
  'REASON_TOO_LONG',
  'CONFLICT',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'RATE_LIMITED',
  'NETWORK',
  'VIEWER_CHANGED',
  'STEP_UP_REQUIRED',
  'MFA_ENROLMENT_REQUIRED',
]);

const knownCode = (e: unknown) =>
  isApiClientError(e) && KNOWN_ERRORS.has(e.code) ? e.code : 'UNKNOWN';

const TONE: Record<TenantStatus, 'success' | 'warning' | 'error'> = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  CLOSED: 'error',
};

/** What each status may become: CLOSED is final. */
const NEXT: Record<TenantStatus, readonly Target[]> = {
  ACTIVE: ['SUSPENDED', 'CLOSED'],
  SUSPENDED: ['ACTIVE', 'CLOSED'],
  CLOSED: [],
};

export function ClubsBoard({ canChange }: { canChange: boolean }) {
  const t = useTranslations('platform.clubs');
  const ids = useId();
  const [reason, setReason] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [changing, setChanging] = useState<{ club: ClubRow; to: Target } | null>(null);
  const [done, setDone] = useState<{ club: string; answer: StatusAnswer } | null>(null);

  const key = submitted ? KEYS.platformClubs({ reason: submitted }) : null;
  const list = useV1SWR<V1Page<ClubRow>>(key, { audited: true });
  const reasonReady = reason.trim().length >= MIN_REASON;

  return (
    <div className="gap-section grid">
      <form
        className="border-border-subtle bg-bg-default grid gap-3 rounded-lg border p-4 sm:max-w-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (!reasonReady) return;
          const r = reason.trim();
          if (r === submitted) void list.mutate();
          else setSubmitted(r);
        }}
      >
        <FormField label={t('reasonLabel')} description={t('reasonHint')}>
          <Input
            id={`${ids}-reason`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            autoComplete="off"
          />
        </FormField>
        <div>
          <Button type="submit" disabled={!reasonReady}>
            {submitted ? t('refresh') : t('open')}
          </Button>
        </div>
      </form>

      {list.error && (
        <InlineNotice variant="error">{t(`error.${knownCode(list.error)}` as never)}</InlineNotice>
      )}

      {done && (
        <InlineNotice
          variant={done.answer.bookings.failed > 0 ? 'warning' : 'success'}
          data-testid="club-status-done"
        >
          {t(`done.${done.answer.to}` as 'done.SUSPENDED', {
            club: done.club,
            cancelled: done.answer.bookings.cancelled,
            failed: done.answer.bookings.failed,
            remaining: done.answer.bookings.remaining,
          })}
        </InlineNotice>
      )}

      {changing && canChange && (
        <ChangeForm
          key={`${changing.club.id}:${changing.to}`}
          club={changing.club}
          to={changing.to}
          onClose={() => setChanging(null)}
          onDone={(answer) => {
            setDone({ club: changing.club.name, answer });
            setChanging(null);
            void list.mutate();
          }}
        />
      )}

      {submitted && needsSkeleton(list) ? (
        <div className="gap-compact grid">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      ) : list.data && list.data.items.length === 0 ? (
        <EmptyState title={t('empty')} />
      ) : list.data ? (
        <ul className="gap-compact grid" data-testid="clubs-list">
          {list.data.items.map((club) => (
            <li key={club.id}>
              <Card density="compact" elevation="flat" className="bg-bg-default">
                <div className="gap-compact flex flex-wrap items-center justify-between">
                  <div className="min-w-0">
                    <p className="text-content-emphasis font-medium">{club.name}</p>
                    <p className="text-content-muted text-sm">
                      /clubs/{club.slug}
                      {club.city ? ` · ${club.city}` : ''}
                    </p>
                  </div>
                  <div className="gap-tight flex flex-wrap items-center">
                    <StatusBadge variant={TONE[club.status]} size="sm">
                      {t(`status.${club.status}` as never)}
                    </StatusBadge>
                    {canChange &&
                      NEXT[club.status].map((to) => (
                        <Button
                          key={to}
                          type="button"
                          size="sm"
                          variant={to === 'ACTIVE' ? 'secondary' : 'destructive'}
                          onClick={() => {
                            setDone(null);
                            setChanging({ club, to });
                          }}
                          data-testid={`club-${to.toLowerCase()}`}
                        >
                          {t(`action.${to}` as never)}
                        </Button>
                      ))}
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ChangeForm({
  club,
  to,
  onClose,
  onDone,
}: {
  club: ClubRow;
  to: Target;
  onClose: () => void;
  onDone: (answer: StatusAnswer) => void;
}) {
  const t = useTranslations('platform.clubs');
  const ids = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState(false);

  const change = useV1Mutation<{ status: Target; reason: string }, StatusAnswer>({
    url: () => V1.clubStatus(club.id),
    method: 'PUT',
    body: (arg) => arg,
  });
  const ready = reason.trim().length >= MIN_REASON;

  async function submit() {
    setError(null);
    try {
      const answer = await change.trigger({ status: to, reason: reason.trim() });
      if (answer) onDone(answer);
    } catch (e) {
      const code = knownCode(e);
      if (code === 'STEP_UP_REQUIRED') setStepUp(true);
      setError(code);
    }
  }

  return (
    <Card
      density="compact"
      elevation="flat"
      className="bg-bg-default"
      data-testid="club-status-form"
    >
      <form
        className="gap-compact grid"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !change.isMutating) void submit();
        }}
      >
        <Heading level={2}>
          {t(`confirm.${to}.title` as 'confirm.ACTIVE.title', { club: club.name })}
        </Heading>
        <p className="text-content-muted text-sm">{t(`confirm.${to}.body` as never)}</p>

        <FormField label={t('confirm.reason')}>
          <Input
            id={`${ids}-reason`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            autoComplete="off"
          />
        </FormField>

        {error && <InlineNotice variant="error">{t(`error.${error}` as never)}</InlineNotice>}

        <div className="gap-tight flex flex-wrap">
          <Button
            type="submit"
            variant={to === 'ACTIVE' ? 'primary' : 'destructive'}
            disabled={!ready}
            loading={change.isMutating}
          >
            {t(`action.${to}` as never)}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('confirm.cancel')}
          </Button>
        </div>
      </form>

      {stepUp && (
        <div className="mt-default">
          <StepUpForm
            onStepped={() => {
              setStepUp(false);
              setError(null);
            }}
          />
        </div>
      )}
    </Card>
  );
}
