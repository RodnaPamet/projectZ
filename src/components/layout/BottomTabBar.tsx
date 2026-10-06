'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ComponentType, SVGProps } from 'react';

import {
  CalendarDays,
  CircleUser,
  Gear,
  Magnifier,
  UserArrowRight,
  Users2,
} from '@/components/ui/icons/nucleo';

import {
  playerTabs,
  type ChromeModules,
  type PlayerChromeKind,
  type PlayerTabIconKey,
} from './nav-items';
import { useSaveData } from './PublicPrefetchLink';
import { TabBar, TabBarLink } from './tab-bar';

/**
 * The player's bottom tab bar, below `md` (T20; #362).
 *
 *   signed out          Играй · Вход
 *   player, coach, —    Играй · (Игри) · Резервации · Профил
 *   club account        Играй · Админ · Профил
 *
 * The tabs come from `nav-items.ts` (`playerTabs`), so `nav-hrefs-resolve`
 * follows every one to a page. Игри is there only when `modules.openPlay` is
 * on (`src/lib/modules.ts`). The bar itself is the shared `TabBar`, the same
 * one the club admin's renders.
 *
 * ═══ EVERY TAB IS A PAGE ═══
 *
 * Профил was the Account tab, which opened the account menu as a bottom sheet
 * over whatever page you were on. It is now `/me/profile`: identity, language,
 * theme, and sign-out. From `md` the avatar keeps the account menu, which links
 * to the same page.
 *
 * ═══ WHERE IT IS NOT ═══
 *
 * /login, /invite/* and /offline: a page whose whole job is one form or one
 * decision, where a Play tab is a way to lose it.
 *
 * ═══ PREFETCH ═══
 *
 * Full, the one place docs/perf/navigation-policy.md allows it: the bar is
 * always on screen, a tap on it is the commonest navigation a phone makes, and
 * a fully prefetched tab renders from the router cache without React's 300 ms
 * reveal throttle (#290). The Админ tab is the exception: it leads into the
 * club admin, whose links stay on the default. Under Save-Data every tab falls
 * back to the default, and
 * the server render assumes Save-Data, so such a browser never starts a full
 * prefetch. `router-cache-policy` pins `fullPrefetch` to this file.
 */
const HIDDEN_ON = [/^\/login(?:\/|$)/, /^\/invite\//, /^\/offline(?:\/|$)/];

const ICONS: Record<PlayerTabIconKey, ComponentType<SVGProps<SVGSVGElement>>> = {
  discover: Magnifier,
  games: Users2,
  bookings: CalendarDays,
  signIn: UserArrowRight,
  profile: CircleUser,
  admin: Gear,
};

export function isTabBarHidden(pathname: string): boolean {
  return HIDDEN_ON.some((re) => re.test(pathname));
}

function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function BottomTabBar({
  kind,
  modules,
  adminHref,
}: {
  kind: PlayerChromeKind;
  modules: ChromeModules;
  /** A CLUB account's way into its admin (`landing.href`); none for anyone else. */
  adminHref: string | null;
}) {
  const t = useTranslations('common.nav');
  const pathname = usePathname() ?? '/';
  const saveData = useSaveData();

  if (isTabBarHidden(pathname)) return null;

  return (
    <TabBar label={t('tabBar')}>
      {playerTabs(kind, { modules, adminHref }).map((tab) => (
        <TabBarLink
          key={tab.href}
          href={tab.href}
          // Not the Админ tab: it opens the club's live diary, and an admin
          // page is never fully prefetched (docs/perf/navigation-policy.md).
          fullPrefetch={!saveData && tab.iconKey !== 'admin'}
          icon={ICONS[tab.iconKey]}
          label={t(tab.labelKey)}
          current={isCurrent(pathname, tab.href)}
          testId={`bottom-tab-${tab.iconKey}`}
        />
      ))}
    </TabBar>
  );
}
