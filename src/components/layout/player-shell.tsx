'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { DrawerAccountSection } from './account-links';
import { AppShellFrame } from './AppShellFrame';
import { BottomTabBar, isTabBarHidden } from './BottomTabBar';
import { HeaderActions } from './header-actions';
import { MobileNavDrawer } from './MobileNavDrawer';
import {
  PROFILE_HREF,
  type AccountLinks,
  type ChromeModules,
  type ShellNavSection,
} from './nav-items';
import { ShellSidebar } from './shell-sidebar';
import { ShellTopBar } from './shell-top-bar';
import { SidebarCollapseProvider } from './sidebar-collapse-context';
import { TabBarSpacer } from './tab-bar';

/** The account menu: Профил, then Изход (the theme row is the menu's own). */
const MENU_ROWS: AccountLinks = { profileHref: PROFILE_HREF, platformHref: null, publicSite: null };

/** The drawer's foot: only Изход, because its sidebar already lists every place. */
const DRAWER_ROWS: AccountLinks = { ...MENU_ROWS, profileHref: null };

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
 *   mobileNav  the same sidebar in the vendored left drawer, and Изход
 *   topChrome  `ShellTopBar`: the hamburger (phones), the wordmark, the bell
 *              (#367) and, from `md`, the account menu (Тема, Профил, Изход);
 *              below `md` the bottom tab bar (Играй · (Игри) · Резервации ·
 *              Профил), fully prefetched outside Save-Data (T30)
 *
 * The sections are plain data decided on the server (`PlayerChrome`), so the
 * sidebar can only list what the server already checked. Below `md` the
 * account menu is not drawn: the Профил tab is the account's place there, and
 * its page holds the theme and sign-out (`ProfileView`).
 *
 * The bar is mounted from the top-chrome slot, as the club admin's is, so it
 * does not reserve its own room; the end of `<main>` does, while the bar
 * shows. `data-scroll-root` and `data-app-shell` are `ClubAdminShell`'s.
 */
export function PlayerShell({
  sections,
  contextName,
  user,
  kind,
  modules,
  children,
}: {
  sections: ShellNavSection[];
  /** The rail's head: the app's name, as upstream's rail names its app. */
  contextName: string;
  user: { userId: string; name: string | null; email: string | null };
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
              onToggleCollapse={onToggleCollapse}
            />
          </SidebarCollapseProvider>
        )}
        mobileNav={({ open, onClose }) => (
          <MobileNavDrawer open={open} onClose={onClose} title={tNav('menu')}>
            <SidebarCollapseProvider collapsed={false}>
              <ShellSidebar sections={sections} contextName={contextName} onNavClick={onClose} />
              <DrawerAccountSection links={DRAWER_ROWS} onNavigate={onClose} />
            </SidebarCollapseProvider>
          </MobileNavDrawer>
        )}
        topChrome={({ onMobileMenuClick }) => (
          <>
            <ShellTopBar
              actions={<HeaderActions viewerId={user.userId} />}
              user={user}
              account={MENU_ROWS}
              menuFromMd
              onMobileMenuClick={onMobileMenuClick}
            />
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
