import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { requireSignedIn } from '@/lib/auth/page-context';
import { isMonth, statementMonthOf } from '@/lib/billing/club-fee';
import { ViewerScope } from '@/lib/data/provider';

import { ClubStatementPanel } from './ClubStatementPanel';

export async function generateMetadata() {
  const t = await getTranslations('platform.fees');
  return { title: t('statementMetaTitle') };
}

/**
 * One club's statement, from the platform (#372): the document the club sees
 * on its own page, read through `/api/v1/platform/fees/{clubId}/statement`
 * with the reason the owner stated on the overview, which links here with it.
 *
 * Holds no authority and reads nothing itself, like the rest of /platform. The
 * month and the reason ride in the URL so the overview's link is the whole
 * request; without a reason the panel asks for one before it reads.
 */
export default async function PlatformClubStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<{ month?: string | string[]; reason?: string | string[] }>;
}) {
  const [{ clubId }, sp] = await Promise.all([params, searchParams]);
  const userId = await requireSignedIn();
  if (!userId) redirect(`/login?next=${encodeURIComponent(`/platform/fees/${clubId}`)}`);

  const t = await getTranslations('platform.fees');
  const month =
    typeof sp.month === 'string' && isMonth(sp.month) ? sp.month : statementMonthOf(new Date());
  const reason = typeof sp.reason === 'string' ? sp.reason : '';

  return (
    <section>
      <header className="mb-6">
        <h1 className="text-content-emphasis text-3xl font-semibold">{t('statementTitle')}</h1>
        <p className="text-content-muted mt-1 text-sm">{t('statementSubtitle')}</p>
      </header>

      <ViewerScope viewerId={userId}>
        <ClubStatementPanel clubId={clubId} month={month} initialReason={reason} />
      </ViewerScope>
    </section>
  );
}
