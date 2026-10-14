'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import type { TournamentDto, TournamentViewDto } from '@/app/api/v1/_lib/tournament-dto';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';

import { useTournamentLabels } from './use-tournament-labels';

/**
 * A tournament in a list (#579): what, where, when, the fee and the places,
 * and the viewer's own entry when there is one. The whole card opens it.
 */
export function TournamentCard({
  tournament: x,
  showClub = true,
}: {
  tournament: TournamentDto | TournamentViewDto;
  showClub?: boolean;
}) {
  const t = useTranslations('tournaments');
  const l = useTournamentLabels();
  const mine = 'myEntry' in x ? x.myEntry : null;

  return (
    <Card
      elevation="flat"
      className="gap-tight focus-within:ring-ring relative flex flex-col focus-within:ring-2"
      data-testid="tournament-card"
      data-tournament-id={x.id}
    >
      <Heading level={3} className="text-base">
        <Link
          href={`/tournaments/${encodeURIComponent(x.id)}`}
          className="after:absolute after:inset-0 focus-visible:outline-none"
        >
          {x.name}
        </Link>
      </Heading>
      <Caption className="block">{l.kind(x)}</Caption>
      <Caption className="block">
        {l.dates(x)}
        {x.venue ? ` · ${x.venue.name}` : ''}
        {showClub ? ` · ${x.club.name}` : ''}
      </Caption>
      <div className="flex flex-wrap gap-2">
        <StatusBadge variant={x.entriesOpen ? 'success' : 'neutral'} icon={null}>
          {x.entriesOpen ? l.places(x) : l.status(x)}
        </StatusBadge>
        <StatusBadge variant="neutral" icon={null}>
          {l.fee(x)}
        </StatusBadge>
        {mine ? (
          <StatusBadge
            variant={mine.status === 'CONFIRMED' ? 'success' : 'info'}
            data-testid="tournament-card-mine"
          >
            {t(`entry.${mine.status}`)}
          </StatusBadge>
        ) : null}
      </div>
    </Card>
  );
}
