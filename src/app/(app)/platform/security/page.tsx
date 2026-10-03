import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { requireSignedIn } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';

import { SecurityPanel } from './SecurityPanel';

export async function generateMetadata() {
  const t = await getTranslations('platform.security');
  return { title: t('metaTitle') };
}

/**
 * Two-step verification for platform admins (#262).
 *
 * Like the moderation page, it holds no authority and reads nothing itself:
 * the panel calls `/api/v1/me/mfa/**`, which works on the caller's own account
 * and session only. The platform layout above has already decided whether to
 * show the platform shell at all (a live grant, or a 404).
 *
 * Every cross-club write now needs a step-up from this account's
 * authenticator, so this is where a new moderator starts: enrol, keep the
 * recovery codes, then work the queue.
 */
export default async function SecurityPage() {
  const userId = await requireSignedIn();
  if (!userId) redirect('/login?next=/platform/security');

  const t = await getTranslations('platform.security');

  return (
    // No <main>: the platform shell owns it (T19).
    <section>
      <header className="mb-6">
        <h1 className="text-content-emphasis text-3xl font-semibold">{t('title')}</h1>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      <ViewerScope viewerId={userId}>
        <SecurityPanel />
      </ViewerScope>
    </section>
  );
}
