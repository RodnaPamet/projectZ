'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import type { OpenGameDto } from '@/app/api/v1/_lib/open-play-dto';
import { GameCard } from '@/components/games/GameCard';
import { Heading } from '@/components/ui/typography';
import { KEYS, type V1Page } from '@/lib/data/keys';
import { useV1SWRInfinite } from '@/lib/data/use-v1-swr';

/**
 * «Търсят играчи» on a venue's page (#376): the open games at this venue,
 * soonest first, from the same `GET /api/v1/games?venue=` the native app reads.
 * Nothing at all when there are none: the page is about booking, and an empty
 * section would only push the slots down.
 */
export function VenueGames({
  venueId,
  venuePath,
  seed,
}: {
  venueId: string;
  venuePath: string;
  seed: V1Page<OpenGameDto>;
}) {
  const t = useTranslations('games.venue');
  const getKey = useMemo(() => KEYS.games({ venue: venueId }), [venueId]);
  const { data, mutate } = useV1SWRInfinite<OpenGameDto>(getKey, {
    fallbackData: [seed],
    keepPreviousData: true,
  });
  const items = data?.[0]?.items ?? [];
  if (items.length === 0) return null;

  return (
    <section
      aria-labelledby="venue-games"
      className="in-shell:px-0 flex flex-col gap-3 px-6 md:px-0"
      data-testid="venue-games"
    >
      <div className="flex items-baseline justify-between gap-3">
        <Heading level={2} id="venue-games" className="text-lg">
          {t('title')}
        </Heading>
        <Link
          href="/games"
          className="text-content-muted hover:text-content-emphasis text-sm underline-offset-4 hover:underline"
        >
          {t('all')}
        </Link>
      </div>
      <ul className="grid gap-3">
        {items.map((g) => (
          <li key={g.id} className="grid">
            <GameCard
              game={g}
              showVenue={false}
              signInHref={`/login?next=${encodeURIComponent(venuePath)}`}
              onChanged={() => void mutate()}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
