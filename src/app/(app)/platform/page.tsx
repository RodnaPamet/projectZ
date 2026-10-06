import { notFound, redirect } from 'next/navigation';

import { platformItemAllowed, platformNav, visibleSections } from '@/components/layout/nav-items';
import { signedInIdentity } from '@/lib/auth/page-context';
import { resolvePlatformAuthority } from '@/lib/auth/platform-admin';

/**
 * `/platform`: the platform's front door, which was a 404 (#345, audit M03).
 *
 * The account menu and the profile link a grant holder here, rather than to a
 * page their grant might not open. It sends them on to the FIRST page of the
 * platform nav their live grant opens: the moderation queue for a moderator,
 * the security page for a grant that carries nothing else. It is the same
 * filter the platform layout draws its nav with, so it never lands anybody on
 * a page the nav would not offer them.
 *
 * The layout above refuses a visitor with no live grant; that is repeated here
 * rather than trusted, because a page and its layout render concurrently.
 */
export default async function PlatformIndexPage() {
  const me = await signedInIdentity();
  if (!me) redirect('/login?next=/platform');

  const { capabilities } = await resolvePlatformAuthority(me.userId);
  const first = visibleSections(platformNav(), (item) => platformItemAllowed(item, capabilities))[0]
    ?.items[0];
  if (!first) notFound();

  redirect(first.href);
}
