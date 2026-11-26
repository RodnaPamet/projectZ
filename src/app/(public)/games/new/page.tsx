import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { listVenueFacets } from '@/app-layer/repositories/venue';
import { bookingViewer } from '@/components/booking/booking-viewer';
import { gamesCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Caption, Heading } from '@/components/ui/typography';
import { KIND_CHOOSER_PATH, PHONE_STEP_PATH } from '@/lib/auth/landing';
import { ViewerScope } from '@/lib/data/provider';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { NEW_GAME_PATH } from '@/lib/open-play/new-game';

import { NewGame } from './NewGame';

export async function generateMetadata() {
  const t = await getTranslations('games.new');
  return { title: t('metaTitle') };
}

/** The server's clock at render, so the first paint offers the hours the HTML did. */
function renderedAt(): string {
  return new Date().toISOString();
}

/**
 * «Създай игра» (#697): book a court and open its game in one flow, as the
 * phone's NewGameView. Booking needs a player account, so each step that is
 * owed comes first and sends the person back here: sign in, "Играч или
 * треньор?" (#416), a confirmed phone (#500). A club account does not book.
 *
 * The sports are the venue list's facets (what some live venue has), read as
 * /venues reads them: cross-tenant, with BYPASSRLS, and only the facet values.
 */
export default async function NewGamePage() {
  const { me, viewer } = await bookingViewer();
  const back = `?next=${encodeURIComponent(NEW_GAME_PATH)}`;
  if (viewer === 'signed-out' || !me) redirect(`/login${back}`);
  if (viewer === 'undecided') redirect(`${KIND_CHOOSER_PATH}${back}`);
  if (viewer === 'no-phone') redirect(`${PHONE_STEP_PATH}${back}`);

  const [t, tNav, facets] = await Promise.all([
    getTranslations('games.new'),
    getTranslations('common.nav'),
    runAsSuperuser((db) => listVenueFacets(db)),
  ]);

  return (
    <div className="bg-bg-page text-content-default safe-area-x">
      <div className="in-shell:p-0 px-6 py-10">
        <PageBreadcrumbs items={gamesCrumbs(tNav, t('title'))} className="hidden" />
        <Heading level={1}>{t('title')}</Heading>
        <Caption className="mt-2 block max-w-prose">{t('intro')}</Caption>
        {viewer === 'club' ? (
          <InlineNotice variant="info" className="mt-6">
            {t('clubAccount')}
          </InlineNotice>
        ) : (
          <ViewerScope viewerId={me.userId}>
            <NewGame sports={facets.sports} renderedAt={renderedAt()} />
          </ViewerScope>
        )}
      </div>
    </div>
  );
}
