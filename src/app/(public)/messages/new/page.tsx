import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { messagesCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { PlayerSearch } from '@/components/messages/PlayerSearch';
import { ChevronLeft } from '@/components/ui/icons/nucleo';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { ViewerScope } from '@/lib/data/provider';

import { messagesViewer } from '../viewer';

export async function generateMetadata() {
  const t = await getTranslations('messaging');
  return { title: t('search.metaTitle') };
}

/**
 * "Ново съобщение" (#375): find a player by name, see their public card, and
 * write. A club is written to from its own page ("Пиши на клуба"), not from
 * here.
 */
export default async function NewMessagePage() {
  const { userId, coach } = await messagesViewer('/messages/new');
  const [t, tNav] = await Promise.all([
    getTranslations('messaging'),
    getTranslations('common.nav'),
  ]);

  return (
    <div className="bg-bg-page text-content-default safe-area-x flex-1">
      <div className="gap-section in-shell:p-0 mx-auto flex w-full max-w-2xl flex-col px-4 py-6 md:px-6 md:py-10">
        <PageBreadcrumbs items={messagesCrumbs(tNav, t('search.title'))} className="hidden" />
        <Link
          href="/messages"
          className="text-content-muted hover:text-content-emphasis inline-flex min-h-11 items-center gap-1 self-start text-sm transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          {t('conversation.back')}
        </Link>
        <Heading level={1}>{t('search.title')}</Heading>
        {coach ? (
          <InlineNotice variant="info">{t('coachNotice')}</InlineNotice>
        ) : (
          <ViewerScope viewerId={userId}>
            <PlayerSearch />
          </ViewerScope>
        )}
      </div>
    </div>
  );
}
