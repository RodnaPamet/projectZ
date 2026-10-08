import type { ReactNode } from 'react';

import { unstable_rethrow } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { clubResourceNouns } from '@/app-layer/usecases/club-nouns';
import { resolveTenantPageContext } from '@/lib/auth/page-context';

import { BottomTabBar } from './BottomTabBar';
import { ClubAdminShell } from './club-admin-shell';
import {
  clubShell,
  displayName,
  platformSections,
  playerAccount,
  playerShellNav,
  PLATFORM_HREF,
  toShellSections,
  type ClubShellData,
  type ShellAccount,
} from './nav-items';
import { chromeReadFailed, playerChrome } from './player-chrome-data';
import { PlayerShell } from './player-shell';
import { SiteHeader } from './SiteHeader';
import { SiteFooter } from './site-footer';

export { chromeIdentity, playerChrome } from './player-chrome-data';

/**
 * The frame around every page of the site (T20, #362), decided ON THE SERVER
 * from `playerChrome`, so the first byte is already the right chrome: no
 * flash of the public header before the shell, and nothing for the client to
 * guess.
 *
 *   signed out   the public header, the page in `<main>`, the footer (`footer`),
 *                and below `md` the bottom tab bar (Играй · Вход)
 *   player,      `PlayerShell`: upstream's AppShell frame with the player's
 *   coach        sidebar (Играй · Резервации · Профил, the modules' items,
 *                and Платформа for a grant holder) and its foot (the account,
 *                the gear, Изход), the bell, the account menu, and below `md`
 *                the drawer and the tab bar
 *   club         `ClubAdminShell` with its club's admin sidebar, exactly as on
 *                its admin pages (owner, 2026-10-07): one account, one kind,
 *                one sidebar
 *
 * Rendered by `src/app/(public)/layout.tsx` (every public page, and /me, so a
 * tap between Играй and Резервации keeps the shell mounted), by the home
 * page's layout for a signed-out visitor, and by the 404.
 *
 * The public chrome is a column at least one screen tall, so a page's root can
 * take `flex-1` and centre itself in what the header and the tab bar leave. It
 * owns the `<main>` landmark in both frames (the shell's `<main>` is the
 * vendored frame's), so a page renders none of its own.
 *
 * `footer` adds the public footer (#368, #369), whose language switch is the
 * one a signed-out visitor can reach. A signed-in account switches its
 * language in the account menu (or on /me/profile), so no frame of theirs has
 * a footer.
 */
export async function PlayerChrome({
  children,
  footer = false,
}: {
  children: ReactNode;
  footer?: boolean;
}) {
  const { me, landing, kind, modules, platform, platformHref } = await playerChrome();

  if (!me || kind === 'signed-out') {
    return (
      <div className="flex min-h-dvh flex-col">
        <SiteHeader />
        <main className="flex flex-1 flex-col">{children}</main>
        {footer ? <SiteFooter /> : null}
        <BottomTabBar kind="signed-out" modules={modules} />
      </div>
    );
  }

  const [tNav, tCommon, tRole] = await Promise.all([
    getTranslations('common.nav'),
    getTranslations('common'),
    getTranslations('admin.staff.role'),
  ]);
  const user = { userId: me.userId, name: me.name, email: me.email };

  if (kind === 'club') {
    const club = await clubFrame(landing?.club?.tenantSlug ?? null, {
      platform,
      me: user,
      t: tNav,
      tRole,
    });
    return (
      <ClubAdminShell
        sections={club?.sections ?? toShellSections(platformSections(platform), tNav)}
        homeHref={club?.homeHref}
        contextName={club?.contextName ?? tCommon('appName')}
        user={user}
        account={club?.account ?? noClubAccount(user, platformHref, tNav)}
        bottomTabs
      >
        {children}
      </ClubAdminShell>
    );
  }

  return (
    <PlayerShell
      sections={toShellSections(playerShellNav(kind, { modules, platform }), tNav)}
      contextName={tCommon('appName')}
      user={user}
      account={playerAccount(user, kind, platform, { nav: tNav, role: tRole })}
      kind={kind}
      modules={modules}
    >
      {children}
    </PlayerShell>
  );
}

/**
 * A CLUB account with no live club to draw (suspended, closed, the membership
 * gone): its name alone at the sidebar's foot, and the gear only to the
 * platform, for a holder of a live grant.
 */
function noClubAccount(
  me: { name: string | null; email: string | null },
  platformHref: string | null,
  tNav: (key: string) => string,
): ShellAccount {
  return {
    identity: {
      name: displayName(me),
      context: null,
      role: platformHref ? tNav('platform') : null,
    },
    admin: platformHref ? { href: PLATFORM_HREF, label: tNav('platform') } : null,
    publicSite: null,
  };
}

/**
 * A CLUB account's frame, off its admin: the same `clubShell` its admin layout
 * draws, from the membership `resolveTenantPageContext` reads for that club
 * (request-cached, so the admin layout asking too is one query), with the
 * courts screen named after what the club plays on (`clubResourceNouns`).
 * `null` when there is no live club to draw: its club suspended or closed, or
 * the membership gone. The account still wears the club frame, with no admin
 * pages in it, never a player's.
 */
async function clubFrame(
  slug: string | null,
  opts: Omit<Parameters<typeof clubShell>[1], 'nouns'>,
): Promise<ClubShellData | null> {
  if (!slug) return null;
  const result = await resolveTenantPageContext(slug).catch((err: unknown) => {
    unstable_rethrow(err);
    chromeReadFailed('membership', err);
    return null;
  });
  if (result?.kind !== 'ok') return null;
  // What the club plays on names its courts screen ("Писти" at a karting
  // club); unreadable, it reads as courts rather than taking the frame down.
  const nouns = await clubResourceNouns(result.ctx.tenantId).catch((err: unknown) => {
    unstable_rethrow(err);
    chromeReadFailed('resource-nouns', err);
    return 'court' as const;
  });
  return clubShell(result.ctx, { ...opts, nouns });
}
