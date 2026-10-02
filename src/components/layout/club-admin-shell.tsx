'use client';

import type { ReactNode } from 'react';
import { useSelectedLayoutSegment } from 'next/navigation';

import { AdminSidebar } from './admin-sidebar';
import { AdminTopBar } from './admin-top-bar';
import { AppShellFrame } from './AppShellFrame';
import { MobileNavDrawer } from './MobileNavDrawer';
import type { ShellNavSection } from './nav-items';
import { SidebarCollapseProvider } from './sidebar-collapse-context';

/**
 * The club-admin shell (and the platform's): inflect's vendored frame with playerz's content.
 *
 * `AppShellFrame` (inflect T07) owns the layout chain, the drawer's open
 * state, the persisted collapse (`playerz:sidebar-collapsed`, through the
 * `uiStorageKey` seam) and closing the drawer on navigation. This supplies its
 * three slots, the way inflect's own `AppShell` does:
 *
 *   sidebar    `AdminSidebar` in the desktop rail, collapsible
 *   mobileNav  the same sidebar in the vendored left drawer (a vaul Sheet),
 *              never collapsed
 *   topChrome  `AdminTopBar`, whose hamburger opens the drawer
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
  fullBleedSegment,
  children,
}: {
  sections: ShellNavSection[];
  homeHref: string;
  contextName: string;
  user: { name: string | null; email: string | null };
  /** The child segment that renders edge to edge, e.g. `'calendar'`. */
  fullBleedSegment?: string;
  children: ReactNode;
}) {
  const segment = useSelectedLayoutSegment();

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
          <MobileNavDrawer open={open} onClose={onClose}>
            <SidebarCollapseProvider collapsed={false}>
              <AdminSidebar sections={sections} contextName={contextName} onNavClick={onClose} />
            </SidebarCollapseProvider>
          </MobileNavDrawer>
        )}
        topChrome={({ onMobileMenuClick }) => (
          <AdminTopBar
            homeHref={homeHref}
            contextName={contextName}
            user={user}
            onMobileMenuClick={onMobileMenuClick}
          />
        )}
      >
        {children}
      </AppShellFrame>
    </div>
  );
}
