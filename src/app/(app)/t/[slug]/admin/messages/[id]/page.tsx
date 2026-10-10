import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getConversation, MessagingError } from '@/app-layer/usecases/messaging';
import { toConversationDto } from '@/app/api/v1/_lib/messaging';
import { clubAdminCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { ConversationView } from '@/components/messages/ConversationView';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';

export async function generateMetadata() {
  const t = await getTranslations('admin.messages');
  return { title: t('conversationMetaTitle') };
}

/**
 * One of the club's conversations (#375), as its staff read it: the player,
 * and each reply named by the colleague who wrote it. The same screen as the
 * player's (`ConversationView`), reading and writing through the club's admin
 * API; it re-reads every 5 seconds while open. Another club's conversation is
 * a 404, as is one the caller's role does not open.
 */
export default async function ClubConversationPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const result = await resolveTenantPageContext(slug);
  if (result.kind === 'unauthenticated') {
    redirect(`/login?next=${encodeURIComponent(`/t/${slug}/admin/messages/${id}`)}`);
  }
  if (result.kind !== 'ok') notFound();
  const { ctx } = result;
  if (!ctx.permissions.includes('messages.club')) notFound();

  const view = await getConversation(
    { kind: 'club', userId: ctx.userId, tenantId: ctx.tenantId },
    id,
  ).catch((err: unknown) => {
    if (err instanceof MessagingError && err.status === 404) return null;
    throw err;
  });
  if (!view) notFound();

  const [t, tNav, tCommon] = await Promise.all([
    getTranslations('admin.messages'),
    getTranslations('common.nav'),
    getTranslations('common'),
  ]);
  const seed = toConversationDto(view);
  const title =
    seed.counterpart.kind === 'player' && seed.counterpart.deleted
      ? tCommon('deletedUser')
      : (seed.counterpart.name ?? t('unnamed'));

  return (
    <section className="flex flex-1 flex-col">
      <PageBreadcrumbs items={[...clubAdminCrumbs(slug, tNav, 'messages'), { label: title }]} />
      <ViewerScope viewerId={ctx.userId}>
        <ConversationView
          side={{ kind: 'club', slug }}
          seed={seed}
          back={{ href: `/t/${slug}/admin/messages`, label: t('back') }}
        />
      </ViewerScope>
    </section>
  );
}
