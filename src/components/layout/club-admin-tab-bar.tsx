'use client';

import { usePathname } from 'next/navigation';

import { Dots } from '@/components/ui/icons/nucleo';

import { NAV_ICONS } from './nav-icons';
import type { ShellNavItem, ShellNavSection } from './nav-items';
import { TabBar, TabBarButton, TabBarLink } from './tab-bar';

/**
 * The club admin's bottom tab bar, below `md` (#362).
 *
 * agrent's pattern (agri-saas `BottomTabBar`): the tabs are NOT a second
 * hard-coded nav list. They are RESOLVED from the sections the sidebar and the
 * drawer already render, `clubAdminNav(slug)` filtered on the server by the
 * role's permissions (`visibleSections`), matched by href SUFFIX so the
 * `/t/{slug}/admin` prefix does not matter. A page the role cannot open was
 * dropped from `sections` before it got here, so it is absent from the bar
 * too: the bar can never offer more than the sidebar.
 *
 *   OWNER / MANAGER   Календар · Кортове · Играчи · Още
 *   STAFF             Календар · Играчи · Още
 *   COACH             Играчи · Още          (holds players.view only)
 *
 * The last tab, "Още", is not a page: it opens the shell's `MobileNavDrawer`,
 * which keeps the long tail (pricing, staff, the public page, the profile,
 * sign-out). It says whether the drawer is open (`aria-expanded`), which the
 * vendored frame hands its top-chrome slot since upstream's `mobileNavOpen`.
 */
export const CLUB_TAB_SUFFIXES = ['/calendar', '/courts', '/players'] as const;

/** The resolved tabs, in `CLUB_TAB_SUFFIXES` order. Pure, for a unit test. */
export function resolveClubTabs(sections: ShellNavSection[]): ShellNavItem[] {
  const items = sections.flatMap((s) => s.items);
  const tabs: ShellNavItem[] = [];
  for (const suffix of CLUB_TAB_SUFFIXES) {
    const match = items.find((it) => it.href.endsWith(suffix));
    if (match) tabs.push(match);
  }
  return tabs;
}

export function ClubAdminTabBar({
  sections,
  label,
  moreLabel,
  moreOpen,
  onMore,
}: {
  sections: ShellNavSection[];
  /** The landmark's name, `common.nav.tabBar`. */
  label: string;
  moreLabel: string;
  /** Whether the drawer "Още" opens is open. */
  moreOpen: boolean;
  /** Opens the drawer: `AppShellFrame`'s `onMobileMenuClick`. */
  onMore: () => void;
}) {
  const pathname = usePathname() ?? '';

  return (
    <TabBar label={label} spacer={false}>
      {resolveClubTabs(sections).map((tab) => (
        <TabBarLink
          key={tab.href}
          href={tab.href}
          // The default prefetch, as on every admin link
          // (docs/perf/navigation-policy.md): no `fullPrefetch` here.
          icon={NAV_ICONS[tab.iconKey]}
          label={tab.label}
          current={pathname === tab.href || pathname.startsWith(`${tab.href}/`)}
          testId={`bottom-tab-${tab.iconKey}`}
        />
      ))}
      <TabBarButton
        icon={Dots}
        label={moreLabel}
        active={moreOpen}
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        data-testid="bottom-tab-more"
        onClick={onMore}
      />
    </TabBar>
  );
}
