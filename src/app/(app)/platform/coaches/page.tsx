import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { platformCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { requireSignedIn } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';

import { CoachQueue } from './CoachQueue';

/**
 * /platform/coaches — the coaches' profiles sent for the platform owner's
 * approval (#545; owner decision 13).
 *
 * The page itself reads nothing about anybody: the queue below it calls the
 * platform API, which checks the grant, COACH_APPROVE and the second factor
 * and writes the audit row, on every request.
 */
export async function generateMetadata() {
  const t = await getTranslations('platform.coaches');
  return { title: t('metaTitle') };
}

export default async function CoachesPage() {
  const userId = await requireSignedIn();
  if (!userId) redirect('/login?next=/platform/coaches');
  const t = await getTranslations('platform.coaches');
  const tNav = await getTranslations('common.nav');

  return (
    // No <main>: the platform layout's shell (T19) owns it.
    <section>
      <PageBreadcrumbs items={platformCrumbs(tNav, 'coaches')} />
      <header className="mb-6">
        <h1 className="text-content-emphasis text-3xl font-semibold">{t('title')}</h1>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>
      <ViewerScope viewerId={userId}>
        <CoachQueue />
      </ViewerScope>
    </section>
  );
}
