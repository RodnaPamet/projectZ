import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { readMyCoachProfile } from '@/app-layer/usecases/coach-profile';
import { toMyCoachProfile } from '@/app/api/v1/_lib/coach-dto';
import { CoachProfileEditor } from '@/components/coach/CoachProfileEditor';
import { coachProfileCrumbs } from '@/components/layout/crumbs';
import { PROFILE_HREF } from '@/components/layout/nav-items';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { requireSignedIn } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';

/**
 * /me/coach — a coach's own profile, and where it stands with the platform
 * (#545; owner decision 13).
 *
 * For COACH accounts. Anyone else is sent to their own profile: there is
 * nothing here for them, and the API under this page refuses them anyway
 * (403 `COACH_ACCOUNT_REQUIRED`). Reading it makes nothing: a coach who has
 * not started sees an empty form.
 *
 * The page hands the editor the profile as the API answers it, and every
 * write the editor makes goes through `/api/v1/me/coach-profile`.
 */
export async function generateMetadata() {
  const t = await getTranslations('coachProfile');
  return { title: t('metaTitle') };
}

export default async function CoachProfilePage() {
  const userId = await requireSignedIn();
  if (!userId) redirect('/login?next=/me/coach');

  const [profile, tNav] = await Promise.all([
    readMyCoachProfile(userId),
    getTranslations('common.nav'),
  ]);
  if (!profile) redirect(PROFILE_HREF);

  return (
    <ViewerScope viewerId={userId}>
      <PageBreadcrumbs items={coachProfileCrumbs(tNav)} />
      <CoachProfileEditor seed={toMyCoachProfile(profile)} />
    </ViewerScope>
  );
}
