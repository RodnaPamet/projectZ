'use client';

import type { ReactNode } from 'react';
import { useSelectedLayoutSegment } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { DrawerPublicSite } from './account-links';
import { AppShellFrame } from './AppShellFrame';
import { ClubAdminTabBar } from './club-admin-tab-bar';
import { MobileNavDrawer } from './MobileNavDrawer';
import type { ShellAccount, ShellNavSection } from './nav-items';
import { ShellSidebar } from './shell-sidebar';
import { ShellTopBar } from './shell-top-bar';
import { SidebarCollapseProvider } from './sidebar-collapse-context';
import { TabBarSpacer } from './tab-bar';

/**
 * The club-admin shell (and the platform's): upstream's vendored frame with playerz's content.
 *
 * `AppShellFrame` (upstream T07) owns the layout chain, the drawer's open
 * state, the persisted collapse (`playerz:sidebar-collapsed`, through the
 * `uiStorageKey` seam) and closing the drawer on navigation. This supplies its
 * three slots, the way upstream's own `AppShell` does:
 *
 *   sidebar    `ShellSidebar` in the desktop rail, collapsible
 *   mobileNav  the same sidebar in the vendored left drawer (a vaul Sheet),
 *              never collapsed, the way out to the public site above its foot
 *   topChrome  `ShellTopBar`, whose hamburger opens the drawer, and below
 *              `md` the bottom tab bar, whose "Още" opens the same drawer
 *
 * ═══ A CLUB ACCOUNT WEARS IT EVERYWHERE (#362, owner 2026-10-07) ═══
 *
 * The club admin's layout renders it, and so does `PlayerChrome`, for a CLUB
 * account on any public page it opens (/venues, a venue, a club's page): the
 * same sections, built by the same `clubShell`, so one account sees one
 * sidebar wherever it goes. A player wears the same frame with its own
 * sidebar (`PlayerShell`).
 *
 * ═══ #362: A WAY AROUND, AND A WAY OUT ═══
 *
 * Below `md` the club admin gets the bottom tab bar (`ClubAdminTabBar`),
 * resolved from the same permission-filtered `sections` as the sidebar, so it
 * can never show a page the role cannot open. Its "Още" is a second opener
 * for the drawer, mounted from the top-chrome slot because that slot is the
 * one the frame hands the opener and the drawer's state to.
 *
 * Every shell has an exit to the public site (#347): in the top bar from `sm`,
 * and in the drawer below it. The sidebar's foot names the account and holds
 * the gear and Изход (owner, 2026-10-08); the top bar ends with the bell and
 * the account menu, as in every shell. All of it (`ShellAccount`) is decided
 * on the server.
 *
 * ═══ #255: THE NAV NO LONGER SCROLLS THE PAGE SIDEWAYS ═══
 *
 * The old club nav put nine links in one row that could not wrap, and a
 * 393 px phone scrolled 541-555 px sideways to reach them. Below `md` the rail
 * is hidden and the links live in the drawer, one per row.
 *
 * ═══ THE DIARY IS FULL-BLEED ═══
 *
 * The frame caps the reading column at `max-w-7xl` unless told otherwise, and
 * a diary with a column per court wants the whole width. The frame takes a
 * boolean rather than reading the route (it is vendored and route-agnostic),
 * so the decision is made here, from the segment below the admin layout.
 *
 * ═══ `data-scroll-root` AND `data-app-shell` ═══
 *
 * globals.css locks html/body to the viewport at `md+` only for a page that
 * opts in with `data-scroll-root`. The frame's `md:h-full` needs that lock,
 * and its content column then owns the scroll. Every other page keeps
 * scrolling like a web page. `data-app-shell` is what the `in-shell:` variant
 * (globals.css) keys on: a page that also renders on the public site drops its
 * own gutter inside a shell, whose `<main>` already pads.
 */
export function ClubAdminShell({
  sections,
  homeHref,
  contextName,
  user,
  account,
  bottomTabs = false,
  fullBleedSegment,
  children,
}: {
  sections: ShellNavSection[];
  /**
   * Where the context name in the top bar leads: the shell's own first page.
   * None for a CLUB account whose club is not live: it has no admin to go back to.
   */
  homeHref?: string;
  contextName: string;
  user: { userId: string; name: string | null; email: string | null };
  /** The sidebar foot's identity and gear, and the way out (`ShellAccount`). */
  account: ShellAccount;
  /** The bottom tab bar below `md`. The club admin has one; the platform does not. */
  bottomTabs?: boolean;
  /** The child segment that renders edge to edge, e.g. `'calendar'`. */
  fullBleedSegment?: string;
  children: ReactNode;
}) {
  const segment = useSelectedLayoutSegment();
  const tNav = useTranslations('common.nav');

  return (
    <div data-scroll-root data-app-shell className="bg-bg-page text-content-default md:h-full">
      <AppShellFrame
        fullBleed={fullBleedSegment !== undefined && segment === fullBleedSegment}
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
          // Named as a place, not as the hamburger's instruction (upstream
          // `title`, #362): "Меню", where "Отвори навигационното меню" stood.
          <MobileNavDrawer open={open} onClose={onClose} title={tNav('menu')}>
            <SidebarCollapseProvider collapsed={false}>
              <ShellSidebar
                sections={sections}
                contextName={contextName}
                account={account}
                onNavClick={onClose}
                beforeFoot={
                  <DrawerPublicSite publicSite={account.publicSite} onNavigate={onClose} />
                }
              />
            </SidebarCollapseProvider>
          </MobileNavDrawer>
        )}
        topChrome={({ onMobileMenuClick, mobileNavOpen }) => (
          <>
            <ShellTopBar
              context={homeHref ? { name: contextName, href: homeHref } : undefined}
              user={user}
              account={account}
              onMobileMenuClick={onMobileMenuClick}
            />
            {/* Mounted from the top-chrome slot because that is the slot the
                frame hands the drawer's opener and state to. It is fixed, so
                where it sits in the DOM does not move it on screen. */}
            {bottomTabs ? (
              <ClubAdminTabBar
                sections={sections}
                label={tNav('tabBar')}
                moreLabel={tNav('more')}
                moreOpen={mobileNavOpen}
                onMore={onMobileMenuClick}
              />
            ) : null}
          </>
        )}
      >
        {children}
        {bottomTabs ? <TabBarSpacer /> : null}
      </AppShellFrame>
    </div>
  );
}
