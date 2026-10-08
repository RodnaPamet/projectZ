import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { getMe } from '@/app-layer/usecases/me';
import { getMyNotificationSettings } from '@/app-layer/usecases/my-notifications';
import { profileCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { playerChrome } from '@/components/layout/player-chrome';
import { requireSignedIn } from '@/lib/auth/page-context';
import { ViewerScope } from '@/lib/data/provider';

import { ProfileView } from './ProfileView';

export async function generateMetadata() {
  const t = await getTranslations('profile');
  return { title: t('metaTitle') };
}

/**
 * `/me/profile` (#362): the Профил tab's page, for every signed-in account.
 *
 * Below `md` this is where the account lives: identity, language, theme, the
 * privacy row, "Платформа" for a holder of a live platform grant, and sign-out.
 * From `md` the account menu links here, and keeps the theme and sign-out
 * itself (see `ProfileView`).
 *
 * #359 adds the display name and the sports with their levels, between the
 * identity and the settings.
 *
 * Who is asking comes from `playerChrome`, the chrome's own request-cached
 * read. The queries this page adds run in parallel: `getMe`, the account the
 * #359 sections edit, as `GET /api/v1/me` answers it; and the email settings
 * (#367), as `GET /api/v1/me/notification-settings` answers them. The platform row is shown only
 * when that read found a live grant; `/platform` authorises for itself.
 */
export default async function ProfilePage() {
  const userId = await requireSignedIn();
  if (!userId) redirect('/login?next=/me/profile');

  const [{ me, platformHref }, mine, notificationSettings, tNav] = await Promise.all([
    playerChrome(),
    getMe(userId),
    getMyNotificationSettings(userId),
    getTranslations('common.nav'),
  ]);
  if (!me || !mine || !notificationSettings) redirect('/login?next=/me/profile');

  // #359's sections read and write `GET`/`PATCH /api/v1/me`; this is their
  // seed, from the same use case, so the first paint is the account and not a
  // skeleton. ViewerScope sends this page's user id with every read and write
  // (409 VIEWER_CHANGED if the tab outlives a switch of account).
  return (
    <ViewerScope viewerId={userId}>
      {/* One crumb, the page's own title: the top bar shows it from md. */}
      <PageBreadcrumbs items={profileCrumbs(tNav)} className="hidden" />
      <ProfileView
        name={me.name}
        email={me.email}
        platformHref={platformHref}
        account={mine}
        showSports={mine.accountKind !== 'CLUB'}
        notificationSettings={notificationSettings}
      />
    </ViewerScope>
  );
}
