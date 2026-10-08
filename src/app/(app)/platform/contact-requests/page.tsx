import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { platformCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { requireSignedIn } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';

import { ContactRequestList } from './ContactRequestList';

export async function generateMetadata() {
  const t = await getTranslations('platform.contactRequests');
  return { title: t('metaTitle') };
}

/**
 * The landing page's club enquiries (#369), for holders of CONTACT_READ.
 *
 * Like the moderation queue, this page holds no authority: everything it
 * shows comes from `GET /api/v1/platform/contact-requests`, which checks a live
 * grant carrying CONTACT_READ on every request and writes an audit row before
 * it answers. The platform layout hides the shell from anybody without a
 * grant; that decides what to show, never what to read.
 */
export default async function ContactRequestsPage() {
  const userId = await requireSignedIn();
  if (!userId) redirect('/login?next=/platform/contact-requests');

  const t = await getTranslations('platform.contactRequests');

  const tNav = await getTranslations('common.nav');

  return (
    // No <main>: the platform layout's shell (T19) owns it.
    <section>
      <PageBreadcrumbs items={platformCrumbs(tNav, 'contact-requests')} />
      <header className="mb-6">
        <h1 className="text-content-emphasis text-3xl font-semibold">{t('title')}</h1>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      <ViewerScope viewerId={userId}>
        <ContactRequestList />
      </ViewerScope>
    </section>
  );
}
