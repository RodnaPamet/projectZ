import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getConversation, MessagingError } from '@/app-layer/usecases/messaging';
import { toConversationDto } from '@/app/api/v1/_lib/messaging';
import { messagesCrumbs } from '@/components/layout/crumbs';
import { clubPublicHref } from '@/components/layout/nav-items';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { ConversationView } from '@/components/messages/ConversationView';
import { ViewerScope } from '@/lib/data/provider';

import { messagesViewer } from '../viewer';

export async function generateMetadata() {
  const t = await getTranslations('messaging');
  return { title: t('conversation.metaTitle') };
}

/**
 * One conversation (#375). The newest page is read here, through the same use
 * case and mapper as `GET /api/v1/me/conversations/{id}`, so the first paint
 * is the conversation; `ConversationView` then re-reads it every 5 seconds
 * while the screen is open, and marks it read. A conversation the caller is
 * not in — or one hidden from them by the other player's block — is a 404,
 * the same answer either way.
 */
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { userId } = await messagesViewer(`/messages/${id}`);

  const view = await getConversation({ kind: 'player', userId }, id).catch((err: unknown) => {
    if (err instanceof MessagingError && err.status === 404) return null;
    throw err;
  });
  if (!view) notFound();

  const [t, tNav, tCommon] = await Promise.all([
    getTranslations('messaging'),
    getTranslations('common.nav'),
    getTranslations('common'),
  ]);
  const seed = toConversationDto(view);
  const title =
    seed.counterpart.kind === 'club'
      ? seed.counterpart.name
      : seed.counterpart.deleted
        ? tCommon('deletedUser')
        : (seed.counterpart.name ?? t('conversation.unnamed'));

  return (
    <div className="bg-bg-page text-content-default safe-area-x flex flex-1 flex-col">
      {/* Съобщения / the person or club (#362's trail), in the top bar from
          md. Not inline on a phone: "‹ Съобщения" is the screen's own way back. */}
      <PageBreadcrumbs items={messagesCrumbs(tNav, title)} className="hidden" />
      <ViewerScope viewerId={userId}>
        <ConversationView
          side={{ kind: 'me' }}
          seed={seed}
          back={{ href: '/messages', label: t('conversation.back') }}
          counterpartHref={
            seed.counterpart.kind === 'club' ? clubPublicHref(seed.counterpart.slug) : null
          }
        />
      </ViewerScope>
    </div>
  );
}
