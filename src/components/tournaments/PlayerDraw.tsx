'use client';

import { useTranslations } from 'next-intl';

import type { DrawDto } from '@/app/api/v1/_lib/tournament-dto';
import { Skeleton } from '@/components/ui/skeleton';
import { Caption, Heading } from '@/components/ui/typography';
import { KEYS } from '@/lib/data/keys';
import { useV1SWR } from '@/lib/data/use-v1-swr';

import { DrawView } from './DrawView';

/**
 * The draw on a tournament's page (#580): for signed-in players, as names on
 * the club's leaderboard are (decision 49). Their own matches stand out, and
 * one on a court links to its booking, where its result is reported.
 */
export function PlayerDraw({
  tournamentId,
  signedIn,
}: {
  tournamentId: string;
  signedIn: boolean;
}) {
  const t = useTranslations('tournaments.draw');
  const { data } = useV1SWR<DrawDto>(signedIn ? KEYS.tournamentDraw(tournamentId) : null);
  return (
    <section className="gap-compact flex flex-col" aria-labelledby="tournament-draw">
      <Heading level={2} className="text-base" id="tournament-draw">
        {t('heading')}
      </Heading>
      {!signedIn ? (
        <Caption data-testid="tournament-draw-sign-in">{t('signIn')}</Caption>
      ) : data ? (
        <DrawView draw={data} linkMyMatches />
      ) : (
        <Skeleton className="h-32 w-full rounded-lg" />
      )}
    </section>
  );
}
