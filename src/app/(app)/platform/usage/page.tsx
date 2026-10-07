import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { Heading } from '@/components/ui/typography';
import { requireSignedIn } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';

import { UsageDashboard } from './UsageDashboard';

export async function generateMetadata() {
  const t = await getTranslations('platform.usage');
  return { title: t('metaTitle') };
}

/**
 * The pilot's numbers (#371, Q40): each club's online share of its bookings,
 * whether it is still active, and the booking funnel.
 *
 * Like the moderation queue, this page holds no authority and reads nothing
 * itself. Everything comes from `GET /api/v1/platform/usage`, which checks a
 * live grant carrying TENANT_READ on every request and writes an audit row
 * with the reason the reader gave before it answers. A read, so no step-up.
 * The platform layout's grant lookup only decides whether the shell shows.
 */
export default async function PlatformUsagePage() {
  const userId = await requireSignedIn();
  if (!userId) redirect('/login?next=/platform/usage');

  const t = await getTranslations('platform.usage');

  return (
    // No <main>: the platform shell owns it (T19).
    <section>
      <header className="mb-6">
        <Heading level={1}>{t('title')}</Heading>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      <ViewerScope viewerId={userId}>
        <UsageDashboard />
      </ViewerScope>
    </section>
  );
}
