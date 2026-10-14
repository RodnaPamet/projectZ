import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { listMyLessons } from '@/app-layer/usecases/coach-lessons';
import { myCoachLinks } from '@/app-layer/usecases/coach-links';
import { readMyCoachProfile } from '@/app-layer/usecases/coach-profile';
import { readMyTimeOff } from '@/app-layer/usecases/coach-time-off';
import { toMyCoachLinks, toMyCoachProfile, toMyLesson } from '@/app/api/v1/_lib/coach-dto';
import { CoachLessonsSection } from '@/components/coach/CoachLessonsSection';
import { CoachProfileEditor } from '@/components/coach/CoachProfileEditor';
import { CoachVenuesSection } from '@/components/coach/CoachVenuesSection';
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
 * write the editor makes goes through `/api/v1/me/coach-profile`. Under the
 * profile: the venues the coach teaches at or asked to, with the terms there,
 * and their days off (#546), on `/api/v1/me/coach-links` and
 * `/api/v1/me/coach-time-off`.
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
  // A coach's account for certain now: where they teach, and their days off.
  const [links, timeOff, lessons] = await Promise.all([
    myCoachLinks(userId),
    readMyTimeOff(userId),
    // «Уроци»: page one of the upcoming ones, by the endpoint's own mapper.
    listMyLessons({ userId, when: 'upcoming' }),
  ]);
  const lessonSeed = { items: lessons.items.map(toMyLesson), nextCursor: lessons.nextCursor };
  // A coach the platform has approved teaches, or may any day; anybody else
  // has the section only while a lesson is still ahead of them.
  const showLessons = profile.state === 'APPROVED' || lessonSeed.items.length > 0;

  return (
    <ViewerScope viewerId={userId}>
      <PageBreadcrumbs items={coachProfileCrumbs(tNav)} />
      <CoachProfileEditor
        seed={toMyCoachProfile(profile)}
        lead={showLessons ? <CoachLessonsSection seed={lessonSeed} /> : null}
      >
        <CoachVenuesSection seed={toMyCoachLinks(links)} timeOffSeed={timeOff ?? []} />
      </CoachProfileEditor>
    </ViewerScope>
  );
}
