'use client';

/**
 * Sidebar collapse state — broadcast to the deeply-nested nav primitives
 * (`NavItem`, `NavSection`) without prop-drilling. The DESKTOP sidebar provides
 * the live collapsed flag (persisted in AppShell); the MOBILE drawer always
 * provides `false` (a drawer is never an icon-rail). `useSidebarCollapsed`
 * defaults to `false` when no provider is mounted, so any standalone NavItem
 * render (tests, storybook) behaves as expanded.
 */
import { createContext, useContext, type ReactNode } from 'react';

const SidebarCollapseContext = createContext<boolean>(false);

export function SidebarCollapseProvider({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: ReactNode;
}) {
  return (
    <SidebarCollapseContext.Provider value={collapsed}>{children}</SidebarCollapseContext.Provider>
  );
}

export function useSidebarCollapsed(): boolean {
  return useContext(SidebarCollapseContext);
}
