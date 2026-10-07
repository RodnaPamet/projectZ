import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { requireSignedIn } from '@/lib/auth/page-context';
import { resolvePlatformAuthority } from '@/lib/auth/platform-admin';
import { monthsBack, shiftMonth, statementMonthOf } from '@/lib/billing/club-fee';
import { ViewerScope } from '@/lib/data/provider';

import { FeesBoard } from './FeesBoard';

export async function generateMetadata() {
  const t = await getTranslations('platform.fees');
  return { title: t('metaTitle') };
}

/**
 * Club fees (#372): every club's fee for a month, for the owner to invoice
 * from, and each club's statement and CSV.
 *
 * ═══ THIS PAGE HOLDS NO AUTHORITY ═══
 *
 * As with the moderation queue, everything it shows comes from
 * `/api/v1/platform/fees/**`, which checks the live grant on every request and
 * audits each read with the reason the reader states. Reading needs
 * TENANT_READ; changing a club's terms needs CLUB_FEE_MANAGE and a step-up.
 *
 * The grant is looked up here only to decide whether to SHOW the terms form —
 * hiding, never deciding. A grant without CLUB_FEE_MANAGE that somehow sent the
 * write would be refused by the binding all the same.
 */
export default async function PlatformFeesPage() {
  const userId = await requireSignedIn();
  if (!userId) redirect('/login?next=/platform/fees');

  const [t, { capabilities }] = await Promise.all([
    getTranslations('platform.fees'),
    resolvePlatformAuthority(userId),
  ]);

  // This month at the club and the eleven before it: a year to invoice from.
  const current = statementMonthOf(new Date());
  const months = monthsBack(shiftMonth(current, -11), current, 12);

  return (
    // No <main>: the platform shell owns it (T19).
    <section>
      <header className="mb-6">
        <h1 className="text-content-emphasis text-3xl font-semibold">{t('title')}</h1>
        <p className="text-content-muted mt-1 text-sm">{t('subtitle')}</p>
      </header>

      <ViewerScope viewerId={userId}>
        <FeesBoard canManage={capabilities.includes('CLUB_FEE_MANAGE')} months={months} />
      </ViewerScope>
    </section>
  );
}
