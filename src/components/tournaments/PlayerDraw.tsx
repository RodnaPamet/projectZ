'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import type { DrawDto, DrawMatchDto } from '@/app/api/v1/_lib/tournament-dto';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Skeleton } from '@/components/ui/skeleton';
import { Caption, Heading } from '@/components/ui/typography';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';

import { DrawView } from './DrawView';
import { ProposeMatchSheet, type ProposedTime } from './ProposeMatchSheet';
import { tournamentErrorKey, type TournamentErrorKey } from './tournament-errors';

/**
 * The draw on a tournament's page (#580): for signed-in players, as names on
 * the club's leaderboard are (decision 49). Their own matches stand out, and
 * one on a court links to its booking, where its result is reported.
 *
 * In a league (#591; decisions 62, 63) a player places their own match: they
 * propose a court and a time, which holds the court until the other side
 * accepts or declines it.
 */
export function PlayerDraw({
  tournamentId,
  signedIn,
  venue,
}: {
  tournamentId: string;
  signedIn: boolean;
  /** Where a league's players place their matches. */
  venue: { id: string; timezone: string } | null;
}) {
  const t = useTranslations('tournaments.draw');
  const tP = useTranslations('tournaments.propose');
  const tT = useTranslations('tournaments');
  const format = useFormatter();
  const { data, mutate } = useV1SWR<DrawDto>(signedIn ? KEYS.tournamentDraw(tournamentId) : null);
  const [proposing, setProposing] = useState<DrawMatchDto | null>(null);
  const [error, setError] = useState<TournamentErrorKey | null>(null);

  const propose = useV1Mutation<ProposedTime & { id: string }, DrawDto>({
    url: ({ id }) => V1.matchProposal(id),
    body: ({ resourceId, startTs, durationMinutes }) => ({ resourceId, startTs, durationMinutes }),
  });
  const accept = useV1Mutation<{ id: string }, DrawDto>({
    url: ({ id }) => V1.acceptMatchProposal(id),
  });
  const letGo = useV1Mutation<{ id: string }, DrawDto>({
    url: ({ id }) => V1.matchProposal(id),
    method: 'DELETE',
  });
  const busy = propose.isMutating || accept.isMutating || letGo.isMutating;

  async function run(fn: () => Promise<DrawDto | undefined>): Promise<boolean> {
    setError(null);
    try {
      const next = await fn();
      if (next) void mutate(next, { revalidate: false });
      return true;
    } catch (e) {
      setError(tournamentErrorKey(e));
      // A time taken or answered meanwhile: show the draw as it is now.
      void mutate();
      return false;
    }
  }

  const opponents = (m: DrawMatchDto) =>
    (m.mySide === 0 ? [m.sideB, m.sideB2] : [m.sideA, m.sideA2])
      .flatMap((e) => e?.players ?? [])
      .map((p) => p.name ?? tT('unnamed'))
      .join(' / ');
  const at = (iso: string) =>
    format.dateTime(new Date(iso), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

  const leagueActions = (m: DrawMatchDto) => {
    if (data?.format !== 'LEAGUE' || data.status !== 'IN_PROGRESS') return null;
    if (!m.mine || m.mySide === null || m.status !== 'READY' || m.scheduled) return null;
    const p = m.proposal;
    if (!p) {
      return venue ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="self-start"
          onClick={() => setProposing(m)}
          data-testid="draw-match-propose"
        >
          {tP('open')}
        </Button>
      ) : null;
    }
    const theirs = p.side !== m.mySide;
    return (
      <div className="gap-tight flex flex-col">
        <Caption data-testid="draw-match-proposal">
          {theirs
            ? tP('theirs', { when: at(p.startTs), court: p.courtName, until: at(p.until) })
            : tP('ours', { when: at(p.startTs), court: p.courtName, until: at(p.until) })}
        </Caption>
        <div className="flex flex-wrap gap-2">
          {theirs ? (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => accept.trigger({ id: m.id }))}
              data-testid="draw-match-accept"
            >
              {tP('accept')}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void run(() => letGo.trigger({ id: m.id }))}
            data-testid="draw-match-let-go"
          >
            {theirs ? tP('decline') : tP('withdraw')}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <section className="gap-compact flex flex-col" aria-labelledby="tournament-draw">
      <Heading level={2} className="text-base" id="tournament-draw">
        {t('heading')}
      </Heading>
      {error ? (
        <InlineNotice variant="error" data-testid="tournament-draw-error">
          {tT(`error.${error}`)}
        </InlineNotice>
      ) : null}
      {!signedIn ? (
        <Caption data-testid="tournament-draw-sign-in">{t('signIn')}</Caption>
      ) : data ? (
        <DrawView draw={data} linkMyMatches actions={leagueActions} />
      ) : (
        <Skeleton className="h-32 w-full rounded-lg" />
      )}
      {proposing && venue ? (
        <ProposeMatchSheet
          venue={venue}
          opponents={opponents(proposing)}
          busy={propose.isMutating}
          onClose={() => setProposing(null)}
          onSubmit={(p) =>
            void run(() => propose.trigger({ id: proposing.id, ...p })).then((ok) => {
              if (ok) setProposing(null);
            })
          }
        />
      ) : null}
    </section>
  );
}
