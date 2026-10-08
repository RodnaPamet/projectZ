import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import {
  AccountNotFoundForDeletionError,
  readMyDeletionStanding,
  type DeletionStanding,
} from '@/app-layer/usecases/account-deletion';
import { getMe } from '@/app-layer/usecases/me';
import { getMyNotificationSettings } from '@/app-layer/usecases/my-notifications';
import { profileCrumbs } from '@/components/layout/crumbs';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { playerChrome } from '@/components/layout/player-chrome';
import { requireSignedIn } from '@/lib/auth/page-context';
import type { DeletionStandingView } from '@/components/profile/DeleteAccountSection';
import { ViewerScope } from '@/lib/data/provider';

import { ProfileView } from './ProfileView';

/** The standing, with its instants as ISO strings for the client section. */
function standingView(s: DeletionStanding): DeletionStandingView {
  if (s.kind !== 'blocked') return s;
  return {
    kind: 'blocked',
    total: s.total,
    bookings: s.bookings.map((b) => ({
      bookingId: b.bookingId,
      venueName: b.venueName,
      courtName: b.courtName,
      timezone: b.timezone,
      startTs: b.startTs.toISOString(),
      endTs: b.endTs.toISOString(),
      role: b.role,
      cure: b.cure,
      cancellableUntil: b.cancellableUntil.toISOString(),
      deletableFrom: b.deletableFrom.toISOString(),
    })),
  };
}

/** Null for an account that is gone (deleted in another tab): the page then signs in again. */
async function readStanding(userId: string): Promise<DeletionStanding | null> {
  try {
    return await readMyDeletionStanding(userId);
  } catch (err) {
    if (err instanceof AccountNotFoundForDeletionError) return null;
    throw err;
  }
}

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

  const [{ me, platformHref }, mine, notificationSettings, standing, tNav] = await Promise.all([
    playerChrome(),
    getMe(userId),
    getMyNotificationSettings(userId),
    // "Изтриване на профила" (#370): may this account delete itself, and if
    // not, why. The API decides again when the button is pressed.
    readStanding(userId),
    getTranslations('common.nav'),
  ]);
  if (!me || !mine || !notificationSettings || !standing) redirect('/login?next=/me/profile');

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
        deletion={standingView(standing)}
      />
    </ViewerScope>
  );
}
