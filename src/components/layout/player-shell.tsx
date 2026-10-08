'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { AppShellFrame } from './AppShellFrame';
import { BottomTabBar, isTabBarHidden } from './BottomTabBar';
import { MobileNavDrawer } from './MobileNavDrawer';
import type { ChromeModules, ShellAccount, ShellNavSection } from './nav-items';
import { ShellSidebar } from './shell-sidebar';
import { ShellTopBar } from './shell-top-bar';
import { SidebarCollapseProvider } from './sidebar-collapse-context';
import { TabBarSpacer } from './tab-bar';

/**
 * The player shell (#362): the frame a PLAYER or a COACH account wears on
 * every page it opens, the same vendored `AppShellFrame` the club admin wears,
 * with the player's sidebar.
 *
 * ═══ WHY (owner, 2026-10-07) ═══
 *
 * Signed in on a computer, the owner could not find the navigation: two text
 * links in a top bar and an avatar in the corner. He asked for upstream's UI,
 * with the navbar on the left. So a signed-in account gets upstream's
 * AppShell, as the club admin already did, and the top-links header is now
 * the signed-out visitor's alone.
 *
 *   sidebar    `ShellSidebar`, collapsible: Играй · (Игри) · Резервации ·
 *              (Съобщения) · Профил, then "Платформа" with the pages a live
 *              grant opens (`playerShellNav`). Auto prefetch, as every rail.
 *              At its foot the account: the name, Играч or Треньор, the grant
 *              if any, the gear to /platform for a grant holder, and Изход.
 *   mobileNav  the same sidebar, foot and all, in the vendored left drawer
 *   topChrome  `ShellTopBar`: the hamburger (phones), the wordmark, the bell
 *              (#367) and the account menu (Тема, Език, Профил, Изход); below
 *              `md` the bottom tab bar (Играй · (Игри) · Резервации · Профил),
 *              fully prefetched outside Save-Data (T30)
 *
 * The sections and the account are plain data decided on the server
 * (`PlayerChrome`), so the shell can only show what the server already
 * checked.
 *
 * The bar is mounted from the top-chrome slot, as the club admin's is, so it
 * does not reserve its own room; the end of `<main>` does, while the bar
 * shows. `data-scroll-root` and `data-app-shell` are `ClubAdminShell`'s.
 */
export function PlayerShell({
  sections,
  contextName,
  user,
  account,
  kind,
  modules,
  children,
}: {
  sections: ShellNavSection[];
  /** The rail's head: the app's name, as upstream's rail names its app. */
  contextName: string;
  user: { userId: string; name: string | null; email: string | null };
  /** The sidebar foot's identity and gear (`playerAccount`). */
  account: ShellAccount;
  kind: 'player' | 'coach';
  modules: ChromeModules;
  children: ReactNode;
}) {
  const tNav = useTranslations('common.nav');
  const barShows = !isTabBarHidden(usePathname() ?? '/');

  return (
    <div data-scroll-root data-app-shell className="bg-bg-page text-content-default md:h-full">
      <AppShellFrame
        sidebar={({ collapsed, onToggleCollapse }) => (
          <SidebarCollapseProvider collapsed={collapsed}>
            <ShellSidebar
              sections={sections}
              contextName={contextName}
              account={account}
              onToggleCollapse={onToggleCollapse}
            />
          </SidebarCollapseProvider>
        )}
        mobileNav={({ open, onClose }) => (
          <MobileNavDrawer open={open} onClose={onClose} title={tNav('menu')}>
            <SidebarCollapseProvider collapsed={false}>
              <ShellSidebar
                sections={sections}
                contextName={contextName}
                account={account}
                onNavClick={onClose}
              />
            </SidebarCollapseProvider>
          </MobileNavDrawer>
        )}
        topChrome={({ onMobileMenuClick }) => (
          <>
            <ShellTopBar user={user} account={account} onMobileMenuClick={onMobileMenuClick} />
            <BottomTabBar kind={kind} modules={modules} spacer={false} />
          </>
        )}
      >
        {children}
        {barShows ? <TabBarSpacer /> : null}
      </AppShellFrame>
    </div>
  );
}
