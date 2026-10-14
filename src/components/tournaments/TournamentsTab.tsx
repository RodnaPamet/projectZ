'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import type { TournamentDto, TournamentViewDto } from '@/app/api/v1/_lib/tournament-dto';
import { EmptyState } from '@/components/ui/empty-state';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Heading } from '@/components/ui/typography';
import { KEYS } from '@/lib/data/keys';
import { cityLabel } from '@/lib/geo/cities';
import { useV1SWR } from '@/lib/data/use-v1-swr';

import { TournamentCard } from './TournamentCard';

const ALL = '';

/**
 * Игри → «Турнири» (#579, decision 53): the viewer's own entries first, then
 * every tournament open for sign-up, by sport and city, soonest first.
 */
export function TournamentsTab({
  seed,
  mine,
  facets,
}: {
  seed: TournamentDto[];
  /** The viewer's live entries; null signed out. */
  mine: TournamentViewDto[] | null;
  facets: { cities: string[]; sports: string[] };
}) {
  const t = useTranslations('tournaments');
  const tGames = useTranslations('games');
  const tSports = useTranslations('sports');
  const tCities = useTranslations('cities');
  const [sport, setSport] = useState(ALL);
  const [city, setCity] = useState(ALL);
  const filtered = sport !== ALL || city !== ALL;
  const { data } = useV1SWR<{ items: TournamentDto[] }>(
    KEYS.openTournaments({ sport: sport || null, city: city || null }),
    filtered ? {} : { fallbackData: { items: seed } },
  );
  const items = data?.items ?? (filtered ? [] : seed);

  return (
    <div className="gap-section grid" data-testid="tournaments-tab">
      {mine && mine.length > 0 ? (
        <section className="gap-compact grid" aria-labelledby="tournaments-mine">
          <Heading level={2} className="text-base" id="tournaments-mine">
            {t('mine')}
          </Heading>
          <ul className="grid gap-4 sm:grid-cols-2">
            {mine.map((x) => (
              <li key={x.id}>
                <TournamentCard tournament={x} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="gap-compact grid" aria-labelledby="tournaments-open">
        <Heading level={2} className="text-base" id="tournaments-open">
          {t('open')}
        </Heading>
        {facets.sports.length > 1 ? (
          <ToggleGroup
            ariaLabel={tGames('filters.sport')}
            options={[
              { value: ALL, label: tGames('filters.allSports') },
              ...facets.sports.map((s) => ({ value: s, label: tSports(s as never) })),
            ]}
            selected={sport}
            selectAction={setSport}
            size="sm"
            className="justify-self-start"
          />
        ) : null}
        {facets.cities.length > 1 ? (
          <ToggleGroup
            ariaLabel={tGames('filters.city')}
            options={[
              { value: ALL, label: tGames('filters.allCities') },
              ...facets.cities.map((c) => ({ value: c, label: cityLabel(tCities, c) })),
            ]}
            selected={city}
            selectAction={setCity}
            size="sm"
            className="justify-self-start"
          />
        ) : null}
        {items.length === 0 ? (
          <EmptyState title={t('none')} description={t('noneHint')} />
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2" data-testid="tournaments-open-list">
            {items.map((x) => (
              <li key={x.id}>
                <TournamentCard tournament={x} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
