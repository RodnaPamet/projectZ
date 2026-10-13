import { getTranslations } from 'next-intl/server';

import {
  listMyGameRequests,
  listOpenGames,
  openGamesFacets,
  type OpenGamesFilter,
} from '@/app-layer/usecases/open-play';
import { toMyGameRequestDto, toOpenGameDto } from '@/app/api/v1/_lib/open-play-dto';
import { gamesCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { chromeIdentity } from '@/components/layout/player-chrome-data';
import { Caption, Heading } from '@/components/ui/typography';
import { ViewerScope } from '@/lib/data/provider';

import { gameFiltersFromParams, gamesTabFrom } from './filters';
import { GamesView } from './GamesView';

export async function generateMetadata() {
  const t = await getTranslations('games');
  return { title: t('metaTitle') };
}

/** The pilot is in Sofia (#379): the day filter's days are its days. */
const PILOT_ZONE = 'Europe/Sofia';

/**
 * Игри (#376), the player's second tab (#362): open games anybody can see,
 * and, signed in, «Моите заявки». Asking needs a signed-in player account;
 * the card sends a visitor to sign in first.
 *
 * Reachable whatever `MODULE_OPEN_PLAY` says, as every module's pages are: the
 * flag only shows the links to it (src/lib/modules.ts).
 */
export default async function GamesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const [t, tNav, me] = await Promise.all([
    getTranslations('games'),
    getTranslations('common.nav'),
    chromeIdentity(),
  ]);
  const tab = gamesTabFrom(sp.tab);
  const filters = gameFiltersFromParams({
    get: (k) => {
      const v = sp[k];
      return typeof v === 'string' ? v : null;
    },
  });
  const viewerId = me?.userId ?? null;

  const [page, facets, mine] = await Promise.all([
    listOpenGames(
      {
        sport: filters.sport as OpenGamesFilter['sport'],
        date: filters.date,
        city: filters.city,
      },
      { viewerId },
    ),
    openGamesFacets(),
    viewerId && tab === 'mine' ? listMyGameRequests({ userId: viewerId }) : Promise.resolve(null),
  ]);

  const view = (
    <GamesView
      initialTab={tab}
      seed={{ items: page.items.map(toOpenGameDto), nextCursor: page.nextCursor }}
      initialFilters={filters}
      mine={mine ? mine.map(toMyGameRequestDto) : null}
      facets={facets}
      signedIn={viewerId !== null}
      timeZone={PILOT_ZONE}
    />
  );

  return (
    <div className="bg-bg-page text-content-default safe-area-x">
      <div className="in-shell:p-0 px-6 py-10">
        {me ? <PageBreadcrumbs items={gamesCrumbs(tNav)} className="hidden" /> : null}
        <Heading level={1}>{t('title')}</Heading>
        <Caption className="mt-2 block max-w-prose">{t('intro')}</Caption>
        {viewerId ? <ViewerScope viewerId={viewerId}>{view}</ViewerScope> : view}
      </div>
    </div>
  );
}
