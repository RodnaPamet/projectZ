import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { listConversations } from '@/app-layer/usecases/messaging';
import { toSummaryDto } from '@/app/api/v1/_lib/messaging';
import { clubAdminCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { InboxList } from '@/components/messages/InboxList';
import { Caption, Heading } from '@/components/ui/typography';
import { resolveTenantPageContext } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';

export async function generateMetadata() {
  const t = await getTranslations('admin.messages');
  return { title: t('metaTitle') };
}

/**
 * The club's shared inbox (#375): every conversation players have with the
 * club, newest first, for its OWNER, MANAGERS and STAFF (`messages.club`, the
 * same the nav item asks). Each person's unread count is their own. Seeded
 * here through the same use case as `GET /api/v1/t/{slug}/admin/conversations`,
 * then re-read every 30 seconds while open.
 */
export default async function ClubMessagesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await resolveTenantPageContext(slug);
  if (result.kind === 'unauthenticated') {
    redirect(`/login?next=${encodeURIComponent(`/t/${slug}/admin/messages`)}`);
  }
  if (result.kind !== 'ok') notFound();
  const { ctx } = result;
  if (!ctx.permissions.includes('messages.club')) notFound();

  const [t, tNav, page] = await Promise.all([
    getTranslations('admin.messages'),
    getTranslations('common.nav'),
    listConversations({ kind: 'club', userId: ctx.userId, tenantId: ctx.tenantId }),
  ]);
  const seed = { items: page.items.map(toSummaryDto), nextCursor: page.nextCursor };

  return (
    <section className="mx-auto w-full max-w-3xl">
      <PageBreadcrumbs items={clubAdminCrumbs(slug, tNav, 'messages')} />
      <header className="mb-6">
        <Heading level={1}>{t('title')}</Heading>
        <Caption className="mt-1">{t('subtitle')}</Caption>
      </header>
      <ViewerScope viewerId={ctx.userId}>
        <InboxList side={{ kind: 'club', slug }} seed={seed} />
      </ViewerScope>
    </section>
  );
}
