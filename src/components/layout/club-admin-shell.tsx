'use client';

import type { ReactNode } from 'react';
import { useSelectedLayoutSegment } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { DrawerAccountSection, type AccountLinks } from './account-links';
import { AdminSidebar } from './admin-sidebar';
import { AdminTopBar } from './admin-top-bar';
import { AppShellFrame } from './AppShellFrame';
import { ClubAdminTabBar } from './club-admin-tab-bar';
import { MobileNavDrawer } from './MobileNavDrawer';
import type { ShellNavSection } from './nav-items';
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
 *   sidebar    `AdminSidebar` in the desktop rail, collapsible
 *   mobileNav  the same sidebar in the vendored left drawer (a vaul Sheet),
 *              never collapsed, with the account rows at its foot
 *   topChrome  `AdminTopBar`, whose hamburger opens the drawer, and below
 *              `md` the bottom tab bar, whose "Още" opens the same drawer
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
 * as the first account row in the drawer, and in the account menu. The
 * account rows themselves (`AccountLinks`) are decided by the layout, on the
 * server.
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
 * ═══ `data-scroll-root` ═══
 *
 * globals.css locks html/body to the viewport at `md+` only for a page that
 * opts in with this attribute. The frame's `md:h-full` needs that lock, and
 * its content column then owns the scroll. Every other page keeps scrolling
 * like a web page.
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
  /** Where the context name in the top bar leads: the shell's own first page. */
  homeHref: string;
  contextName: string;
  user: { name: string | null; email: string | null };
  /** The account rows, in the menu and at the foot of the drawer. */
  account: AccountLinks;
  /** The bottom tab bar below `md`. The club admin has one; the platform does not. */
  bottomTabs?: boolean;
  /** The child segment that renders edge to edge, e.g. `'calendar'`. */
  fullBleedSegment?: string;
  children: ReactNode;
}) {
  const segment = useSelectedLayoutSegment();
  const tNav = useTranslations('common.nav');

  return (
    <div data-scroll-root className="bg-bg-page text-content-default md:h-full">
      <AppShellFrame
        fullBleed={fullBleedSegment !== undefined && segment === fullBleedSegment}
        sidebar={({ collapsed, onToggleCollapse }) => (
          <SidebarCollapseProvider collapsed={collapsed}>
            <AdminSidebar
              sections={sections}
              contextName={contextName}
              onToggleCollapse={onToggleCollapse}
            />
          </SidebarCollapseProvider>
        )}
        mobileNav={({ open, onClose }) => (
          // Named as a place, not as the hamburger's instruction (upstream
          // `title`, #362): "Меню", where "Отвори навигационното меню" stood.
          <MobileNavDrawer open={open} onClose={onClose} title={tNav('menu')}>
            <SidebarCollapseProvider collapsed={false}>
              <AdminSidebar sections={sections} contextName={contextName} onNavClick={onClose} />
              <DrawerAccountSection links={account} onNavigate={onClose} />
            </SidebarCollapseProvider>
          </MobileNavDrawer>
        )}
        topChrome={({ onMobileMenuClick, mobileNavOpen }) => (
          <>
            <AdminTopBar
              homeHref={homeHref}
              contextName={contextName}
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
