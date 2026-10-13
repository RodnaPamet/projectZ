import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { platformCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { requireSignedIn } from '@/lib/auth/page-context';
import { resolvePlatformAuthority } from '@/lib/auth/platform-admin';
import { ViewerScope } from '@/lib/data/provider';

import { ClubsBoard } from './ClubsBoard';

export async function generateMetadata() {
  const t = await getTranslations('platform.clubs');
  return { title: t('metaTitle') };
}

/** Every club and its status; suspend, close or reopen one (#254). */
export default async function PlatformClubsPage() {
  const userId = await requireSignedIn();
  if (!userId) redirect('/login?next=/platform/clubs');

  const [t, tNav, { capabilities }] = await Promise.all([
    getTranslations('platform.clubs'),
    getTranslations('common.nav'),
    resolvePlatformAuthority(userId),
  ]);

  return (
    <section>
      <PageBreadcrumbs items={platformCrumbs(tNav, 'clubs')} />
      <header className="mb-6">
        <h1 className="text-content-emphasis text-3xl font-semibold">{t('title')}</h1>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      <ViewerScope viewerId={userId}>
        <ClubsBoard canChange={capabilities.includes('TENANT_SUSPEND')} />
      </ViewerScope>
    </section>
  );
}
