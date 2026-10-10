import { getTranslations } from 'next-intl/server';

import { playerChrome } from '@/components/layout/player-chrome-data';
import { ViewerScope } from '@/lib/data/provider';

import { StartConversationButton } from './StartConversationButton';

/**
 * "Пиши на клуба" (#375) on a club's and a venue's public page: any signed-in
 * player may write to any club. Drawn only for a PLAYER account while the
 * messaging module is on; a club account writes from its own inbox, and a
 * visitor who is not signed in has nobody to write as. The chrome's reads are
 * request-cached, so this costs the page no query of its own.
 */
export async function WriteToClub({
  clubSlug,
  className,
}: {
  clubSlug: string;
  className?: string;
}) {
  const { me, kind, modules } = await playerChrome();
  if (!me || kind !== 'player' || !modules.messaging) return null;
  const t = await getTranslations('messaging.start');
  return (
    <ViewerScope viewerId={me.userId}>
      <StartConversationButton
        to={{ club: clubSlug }}
        label={t('writeToClub')}
        className={className}
        testId="write-to-club"
      />
    </ViewerScope>
  );
}
