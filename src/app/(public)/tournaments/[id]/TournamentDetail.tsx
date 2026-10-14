'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import type { PlayerCardDto as PlayerCard } from '@/app/api/v1/_lib/messaging';
import type { TournamentViewDto } from '@/app/api/v1/_lib/tournament-dto';
import { PhoneRequiredNotice } from '@/components/phone/PhoneRequiredNotice';
import { PartnerPicker } from '@/components/tournaments/PartnerPicker';
import { PlayerDraw } from '@/components/tournaments/PlayerDraw';
import {
  tournamentErrorKey,
  type TournamentErrorKey,
} from '@/components/tournaments/tournament-errors';
import { useTournamentLabels } from '@/components/tournaments/use-tournament-labels';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';

const ConfirmDialog = dynamic(() =>
  import('@/components/ui/confirm-dialog').then((m) => m.ConfirmDialog),
);

/**
 * One tournament, as a player sees it (#579): what it is, and their entry.
 *
 *   signed out, sign-up open        «Влезте, за да се запишете»
 *   signed in, not entered          «Запиши се», or for doubles the partner
 *                                   first (decision 50)
 *   entered                         where it stands: waiting for the club, on
 *                                   the waiting list and at what place (51),
 *                                   confirmed, declined; and «Оттегли се»
 */
export function TournamentDetail({
  seed,
  signedIn,
  loginHref,
}: {
  seed: TournamentViewDto;
  signedIn: boolean;
  loginHref: string;
}) {
  const t = useTranslations('tournaments');
  const tCommon = useTranslations('common');
  const l = useTournamentLabels();
  const [partner, setPartner] = useState<PlayerCard | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [error, setError] = useState<TournamentErrorKey | null>(null);

  const { data, mutate } = useV1SWR<TournamentViewDto>(KEYS.tournament(seed.id), {
    fallbackData: seed,
  });
  const x = data ?? seed;
  const mine = x.myEntry;

  const enter = useV1Mutation<{ partnerUserId: string | null }, TournamentViewDto>({
    url: () => V1.enterTournament(x.id),
    body: (b) => (b.partnerUserId ? { partnerUserId: b.partnerUserId } : {}),
  });
  const withdraw = useV1Mutation<{ entryId: string }, TournamentViewDto | null>({
    url: ({ entryId }) => V1.withdrawTournamentEntry(entryId),
    method: 'DELETE',
  });

  async function signUp() {
    setError(null);
    if (x.teamSize === 2 && !partner) {
      setError('TOURNAMENT_PARTNER_REQUIRED');
      return;
    }
    try {
      const next = await enter.trigger({ partnerUserId: partner?.userId ?? null });
      setPartner(null);
      if (next) void mutate(next, { revalidate: false });
    } catch (e) {
      setError(tournamentErrorKey(e));
      void mutate();
    }
  }

  async function confirmWithdraw() {
    if (!mine) return;
    setError(null);
    try {
      await withdraw.trigger({ entryId: mine.id });
      void mutate();
    } catch (e) {
      setError(tournamentErrorKey(e));
    }
  }

  const live = mine && (mine.status === 'PENDING' || mine.status === 'CONFIRMED');

  return (
    <div className="gap-section flex flex-col" data-testid="tournament-detail">
      <header className="gap-tight flex flex-col">
        <Heading level={1}>{x.name}</Heading>
        <Caption className="block">{l.kind(x)}</Caption>
        <div className="flex flex-wrap gap-2">
          <StatusBadge
            variant={x.entriesOpen ? 'success' : 'neutral'}
            icon={null}
            data-testid="tournament-status"
          >
            {l.status(x)}
          </StatusBadge>
          <StatusBadge variant="neutral" icon={null}>
            {l.places(x)}
          </StatusBadge>
          {x.pending > 0 ? (
            <StatusBadge variant="neutral" icon={null}>
              {t('waitingCount', { count: x.pending })}
            </StatusBadge>
          ) : null}
        </div>
      </header>

      <Card elevation="flat" density="none">
        <dl className="divide-border-subtle divide-y text-sm">
          <Row label={t('when')} value={l.dates(x)} />
          {x.entriesCloseAt ? (
            <Row label={t('entriesClose')} value={l.when(x.entriesCloseAt)} />
          ) : null}
          {x.venue ? (
            <Row
              label={t('where')}
              value={
                x.venue.publicSlug ? (
                  <Link
                    href={`/venues/${encodeURIComponent(x.venue.publicSlug)}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {x.venue.name}
                  </Link>
                ) : (
                  x.venue.name
                )
              }
            />
          ) : null}
          <Row
            label={t('club')}
            value={
              <Link
                href={`/clubs/${encodeURIComponent(x.club.slug)}`}
                className="underline-offset-4 hover:underline"
              >
                {x.club.name}
              </Link>
            }
          />
          <Row label={t('fee')} value={l.fee(x)} />
        </dl>
      </Card>

      {x.description ? (
        <p
          className="text-content-default text-sm break-words whitespace-pre-wrap"
          data-testid="tournament-description"
        >
          {x.description}
        </p>
      ) : null}

      <section className="gap-tight flex flex-col" aria-labelledby="tournament-entry">
        <Heading level={2} tone="muted" className="text-sm" id="tournament-entry">
          {t('entryHeading')}
        </Heading>
        <Card elevation="flat" className="gap-default flex flex-col" data-testid="tournament-entry">
          {mine ? (
            <>
              <StatusBadge
                variant={
                  mine.status === 'CONFIRMED'
                    ? 'success'
                    : mine.status === 'PENDING'
                      ? 'info'
                      : 'neutral'
                }
                className="self-start"
                data-testid="tournament-entry-status"
              >
                {t(`entry.${mine.status}`)}
              </StatusBadge>
              {mine.waitingPosition ? (
                <Caption data-testid="tournament-entry-waiting">
                  {t('waitingPosition', { place: mine.waitingPosition })}
                </Caption>
              ) : null}
              {mine.partner ? (
                <Caption>
                  {t(mine.role === 'entrant' ? 'withPartner' : 'namedBy', {
                    name: mine.partner.deleted
                      ? tCommon('deletedUser')
                      : (mine.partner.name ?? t('unnamed')),
                  })}
                </Caption>
              ) : null}
              {live && (x.status === 'REGISTRATION' || x.status === 'DRAFT') ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="self-start"
                  onClick={() => setWithdrawing(true)}
                  data-testid="tournament-withdraw"
                >
                  {t('withdraw')}
                </Button>
              ) : null}
            </>
          ) : !x.entriesOpen ? (
            <Caption>{t('closed')}</Caption>
          ) : !signedIn ? (
            <>
              <p className="text-content-default text-sm">{t('signIn')}</p>
              <Link
                href={loginHref}
                className={buttonVariants({ variant: 'primary', className: 'self-start' })}
              >
                {t('signInButton')}
              </Link>
            </>
          ) : (
            <>
              {x.teamSize === 2 ? (
                <div className="gap-tight flex flex-col">
                  <span className="text-content-default text-sm font-medium">
                    {t('partner.label')}
                  </span>
                  <PartnerPicker chosen={partner} onChoose={setPartner} />
                </div>
              ) : null}
              <Caption>{x.entryFeeCents > 0 ? t('feeNote') : t('enterNote')}</Caption>
              <Button
                type="button"
                className="self-start"
                loading={enter.isMutating}
                disabled={enter.isMutating}
                onClick={() => void signUp()}
                data-testid="tournament-enter"
              >
                {x.teamSize === 2 ? t('enterPair') : t('enter')}
              </Button>
            </>
          )}
        </Card>
        {error === 'PHONE_REQUIRED' ? (
          <PhoneRequiredNotice />
        ) : error ? (
          <InlineNotice variant="error" data-testid="tournament-error">
            {t(`error.${error}`)}
          </InlineNotice>
        ) : null}
      </section>

      {/* The draw (#580), once it is made. */}
      {x.status === 'IN_PROGRESS' || x.status === 'COMPLETE' ? (
        <PlayerDraw tournamentId={x.id} signedIn={signedIn} />
      ) : null}

      {withdrawing ? (
        <ConfirmDialog
          showModal={withdrawing}
          setShowModal={setWithdrawing}
          title={t('withdrawConfirm.title')}
          description={t('withdrawConfirm.description')}
          confirmLabel={t('withdrawConfirm.yes')}
          cancelLabel={t('withdrawConfirm.no')}
          onConfirm={() => void confirmWithdraw()}
        />
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <dt className="text-content-muted">{label}</dt>
      <dd className="text-content-default text-right">{value}</dd>
    </div>
  );
}
