'use client';

import { useTranslations } from 'next-intl';

import type { TournamentDto } from '@/app/api/v1/_lib/tournament-dto';
import { Heading } from '@/components/ui/typography';

import { TournamentCard } from './TournamentCard';

/** «Турнири» on a club's page (#579, decision 53): open for sign-up or under way. */
export function ClubTournaments({ items }: { items: TournamentDto[] }) {
  const t = useTranslations('club.tournaments');
  if (items.length === 0) return null;
  return (
    <section
      aria-labelledby="club-tournaments"
      className="in-shell:px-0 flex flex-col gap-3 px-6 md:px-0"
    >
      <Heading level={2} id="club-tournaments">
        {t('title')}
      </Heading>
      <ul className="grid gap-4 sm:grid-cols-2" data-testid="club-tournaments">
        {items.map((x) => (
          <li key={x.id}>
            <TournamentCard tournament={x} showClub={false} />
          </li>
        ))}
      </ul>
    </section>
  );
}
