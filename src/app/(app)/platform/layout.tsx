import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ClubAdminShell } from '@/components/layout/club-admin-shell';
import { platformNav, toShellSections, visibleSections } from '@/components/layout/nav-items';
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
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const me = await signedInIdentity();
  if (!me) redirect('/login?next=/platform/moderation');

  const [{ capabilities }, tNav, tCommon] = await Promise.all([
    resolvePlatformAuthority(me.userId),
    getTranslations('common.nav'),
    getTranslations('platform'),
  ]);

  const sections = visibleSections(platformNav(), (item) => capabilities.includes(item.requires));
  if (sections.length === 0) notFound();

  return (
    <ClubAdminShell
      sections={toShellSections(sections, tNav)}
      homeHref={sections[0]!.items[0]!.href}
      contextName={tCommon('name')}
      user={{ name: me.name, email: me.email }}
    >
      {children}
    </ClubAdminShell>
  );
}
