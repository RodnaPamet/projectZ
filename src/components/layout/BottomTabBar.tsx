'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { NAV_ICONS } from './nav-icons';
import { playerTabs, type ChromeModules, type PlayerChromeKind } from './nav-items';
import { useSaveData } from './PublicPrefetchLink';
import { TabBar, TabBarLink } from './tab-bar';

/**
 * The player's bottom tab bar, below `md` (T20; #362).
 *
 *   signed out          Играй · Вход                      (the public chrome)
 *   player, coach       Играй · (Игри) · Резервации · Профил   (the player shell)
 *
 * The tabs come from `nav-items.ts` (`playerTabs`): signed in, they are
 * resolved from the player shell's own sidebar items, so the bar never offers
 * a page the sidebar does not, and `nav-hrefs-resolve` follows every one to a
 * page. Игри is there only when `modules.openPlay` is on (`src/lib/modules.ts`).
 * A CLUB account wears its admin's bar, `ClubAdminTabBar`, on every page. The
 * bar itself is the shared `TabBar`.
 *
 * ═══ EVERY TAB IS A PAGE ═══
 *
 * Профил is `/me/profile`: identity, language, theme, and sign-out. From `md`
 * the avatar keeps the account menu, which links to the same page.
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
 * reveal throttle (#290). Every tab is a player page that revalidates after
 * paint; no tab leads into the club admin any more (a club account has the
 * admin's own bar). Under Save-Data every tab falls back to the default, and
 * the server render assumes Save-Data, so such a browser never starts a full
 * prefetch. `router-cache-policy` pins `fullPrefetch` to this file.
 *
 * ═══ SPACER ═══
 *
 * In the public chrome the bar ends the page and reserves its own room. The
 * player shell mounts it from the frame's top-chrome slot instead, so it
 * passes `spacer={false}` and pads the end of its `<main>` itself, as the club
 * admin's shell does.
 */
const HIDDEN_ON = [
  /^\/login(?:\/|$)/,
  /^\/invite\//,
  /^\/offline(?:\/|$)/,
  // An open conversation (#375): the composer owns the foot of the screen, as
  // in every messaging app; "‹ Съобщения" at its top is the way out.
  /^\/messages\/(?!new(?:\/|$))[^/]+\/?$/,
];

export function isTabBarHidden(pathname: string): boolean {
  return HIDDEN_ON.some((re) => re.test(pathname));
}

function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function BottomTabBar({
  kind,
  modules,
  spacer = true,
}: {
  kind: Exclude<PlayerChromeKind, 'club'>;
  modules: ChromeModules;
  /** Reserve the bar's height at the end of the page (see SPACER). */
  spacer?: boolean;
}) {
  const t = useTranslations('common.nav');
  const pathname = usePathname() ?? '/';
  const saveData = useSaveData();

  if (isTabBarHidden(pathname)) return null;

  return (
    <TabBar label={t('tabBar')} spacer={spacer}>
      {playerTabs(kind, modules).map((tab) => (
        <TabBarLink
          key={tab.href}
          href={tab.href}
          fullPrefetch={!saveData}
          icon={NAV_ICONS[tab.iconKey]}
          label={t(tab.labelKey)}
          current={isCurrent(pathname, tab.href)}
          testId={`bottom-tab-${tab.iconKey}`}
        />
      ))}
    </TabBar>
  );
}
