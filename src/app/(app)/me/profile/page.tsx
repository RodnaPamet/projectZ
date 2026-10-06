import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { playerChrome } from '@/components/layout/SiteHeader';
import { requireSignedIn } from '@/lib/auth/page-context';

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
 * A minimal first page by design. #359 adds the sports and levels, in the
 * place `ProfileView` marks for them.
 *
 * Who is asking comes from `playerChrome`, the header's own request-cached
 * read, so this page adds no query of its own. The platform row is shown only
 * when that read found a live grant; `/platform` authorises for itself.
 */
export default async function ProfilePage() {
  const userId = await requireSignedIn();
  if (!userId) redirect('/login?next=/me/profile');

  const { me, account } = await playerChrome();
  if (!me || !account) redirect('/login?next=/me/profile');

  return <ProfileView name={me.name} email={me.email} platformHref={account.platformHref} />;
}
