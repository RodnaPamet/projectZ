import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ClubAdminShell } from '@/components/layout/club-admin-shell';
import {
  PLATFORM_HREF,
  platformItemAllowed,
  platformNav,
  PROFILE_HREF,
  toShellSections,
  visibleSections,
} from '@/components/layout/nav-items';
import { signedInIdentity } from '@/lib/auth/page-context';
import { resolvePlatformAuthority } from '@/lib/auth/platform-admin';

/**
 * The platform shell: the same frame as the club admin, for holders of a platform grant (T19).
 *
 * ═══ THE GATE IS THE DATABASE'S GRANT, AND IT ONLY HIDES ═══
 *
 * `resolvePlatformAuthority` reads the live grant fresh (never the token), so
 * a revoked grant stops showing the shell on the next request. Without a grant
 * carrying a capability the nav offers, the answer is a 404: the platform
 * tree is not advertised to people who cannot use it.
 *
 * This decides what to SHOW, never what to DO. Every read and every decision
 * still goes through `/api/v1/platform/**`, which checks the grant and writes
 * an audit row on each request (`platform-route-discipline`). It is the
 * platform tree asking, which is the one place platform authority may be
 * asked about.
 *
 * The page below stays signed-in-only on its own: a layout and its page
 * render concurrently, so the page cannot assume this ran.
 *
 * ═══ THE WAY OUT (#347) ═══
 *
 * "Към сайта" in the top bar from `sm`, first in the account menu and at the
 * foot of the drawer, to the public home page. The wordmark goes there too;
 * the shell's name leads back to `/platform`, which redirects to the first
 * page the grant opens.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const me = await signedInIdentity();
  if (!me) redirect('/login?next=/platform/moderation');

  const [{ capabilities }, tNav, tPlatform] = await Promise.all([
    resolvePlatformAuthority(me.userId),
    getTranslations('common.nav'),
    getTranslations('platform'),
  ]);

  const sections = visibleSections(platformNav(), (item) =>
    platformItemAllowed(item, capabilities),
  );
  if (sections.length === 0) notFound();

  return (
    <ClubAdminShell
      sections={toShellSections(sections, tNav)}
      homeHref={PLATFORM_HREF}
      contextName={tPlatform('name')}
      user={{ name: me.name, email: me.email }}
      account={{
        profileHref: PROFILE_HREF,
        clubAdmin: null,
        // Already in it: the menu does not offer the shell it is in.
        platformHref: null,
        publicSite: { href: '/', label: tNav('toSite') },
      }}
    >
      {children}
    </ClubAdminShell>
  );
}
