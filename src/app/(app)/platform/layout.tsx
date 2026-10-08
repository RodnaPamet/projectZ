import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ClubAdminShell } from '@/components/layout/club-admin-shell';
import {
  clubAdminHref,
  displayName,
  PLATFORM_HREF,
  platformItemAllowed,
  platformNav,
  SIGNED_IN_HOME,
  toShellSections,
  visibleSections,
  type ShellAccount,
} from '@/components/layout/nav-items';
import { playerChrome } from '@/components/layout/player-chrome';

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
 * "Към сайта" in the top bar from `sm`, and in the drawer below it, to the
 * site: Играй, where `/` sends anybody signed in (#362), linked directly. The
 * wordmark goes there too; the shell's name leads back to `/platform`, which
 * redirects to the first page the grant opens.
 *
 * ═══ THE SIDEBAR'S FOOT (#362, owner 2026-10-08) ═══
 *
 * The account as every shell names it: the name; the club for a club account,
 * the account's kind otherwise; and the grant. The gear is the club admin for
 * a club account (its sidebar elsewhere lists Платформа), `/platform` for
 * everybody else. The viewer's kind and club come from `playerChrome`, the
 * request-cached read the site's own chrome makes, which also holds the live
 * grant this layout gates on.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const [{ me, landing, kind, platform: capabilities }, tNav, tPlatform, tRole] = await Promise.all(
    [
      playerChrome(),
      getTranslations('common.nav'),
      getTranslations('platform'),
      getTranslations('admin.staff.role'),
    ],
  );
  if (!me) redirect('/login?next=/platform/moderation');

  const sections = visibleSections(platformNav(), (item) =>
    platformItemAllowed(item, capabilities),
  );
  if (sections.length === 0) notFound();

  const club = kind === 'club' ? (landing?.club ?? null) : null;
  const account: ShellAccount = {
    identity: {
      name: displayName(me),
      context: club
        ? club.tenantName
        : kind === 'club'
          ? null
          : tRole(kind === 'coach' ? 'COACH' : 'PLAYER'),
      role: tNav('platform'),
    },
    admin: club
      ? { href: clubAdminHref(club.tenantSlug), label: tNav('admin') }
      : { href: PLATFORM_HREF, label: tNav('platform') },
    publicSite: { href: SIGNED_IN_HOME, label: tNav('toSite') },
  };

  return (
    <ClubAdminShell
      sections={toShellSections(sections, tNav)}
      homeHref={PLATFORM_HREF}
      contextName={tPlatform('name')}
      user={{ userId: me.userId, name: me.name, email: me.email }}
      account={account}
    >
      {children}
    </ClubAdminShell>
  );
}
