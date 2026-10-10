import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { listConversations } from '@/app-layer/usecases/messaging';
import { toSummaryDto } from '@/app/api/v1/_lib/messaging';
import { messagesCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { buttonVariants } from '@/components/ui/button-variants';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { ViewerScope } from '@/lib/data/provider';

import { MessagesTabs } from './MessagesTabs';
import { inboxTabFrom } from './tabs';
import { messagesViewer } from './viewer';

export async function generateMetadata() {
  const t = await getTranslations('messaging');
  return { title: t('metaTitle') };
}

/**
 * Съобщения (#375): the player's inbox — Разговори and «Заявки» — and the way
 * to a new conversation.
 *
 * As /me/bookings: the open tab's first page is read here, through the same
 * use case and mapper as `GET /api/v1/me/conversations`, so the first paint is
 * the list; `InboxList` then holds it under that endpoint's key and re-reads
 * it every 30 seconds while the tab is visible. ViewerScope sends this page's
 * user id with every read, so a tab left open across a switch of account is
 * refused rather than shown the other person's inbox.
 *
 * Reachable whatever `MODULE_MESSAGING` says, as every module's pages are:
 * the flag only hides the links to it.
 */
export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { userId, coach } = await messagesViewer('/messages');
  const tab = inboxTabFrom((await searchParams).tab);

  const [t, tNav, page] = await Promise.all([
    getTranslations('messaging'),
    getTranslations('common.nav'),
    listConversations({ kind: 'player', userId }, { tab }),
  ]);
  const seed = { items: page.items.map(toSummaryDto), nextCursor: page.nextCursor };

  return (
    <div className="bg-bg-page text-content-default safe-area-x flex-1">
      <div className="in-shell:p-0 mx-auto w-full max-w-2xl px-4 py-6 md:px-6 md:py-10">
        <PageBreadcrumbs items={messagesCrumbs(tNav)} className="hidden" />
        <div className="mb-section flex items-center justify-between gap-3">
          <Heading level={1}>{t('title')}</Heading>
          {coach ? null : (
            <Link
              href="/messages/new"
              className={buttonVariants({ variant: 'primary' })}
              data-testid="messages-new"
            >
              {t('new')}
            </Link>
          )}
        </div>

        {coach ? (
          <InlineNotice variant="info" className="mb-section" data-testid="messages-coach-notice">
            {t('coachNotice')}
          </InlineNotice>
        ) : null}

        <ViewerScope viewerId={userId}>
          <MessagesTabs initialTab={tab} seed={seed} />
        </ViewerScope>
      </div>
    </div>
  );
}
