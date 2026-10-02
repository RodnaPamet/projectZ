'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type ComponentType, type SVGProps } from 'react';

import { useIsBelowMd } from '@/components/ui/hooks/use-is-below-md';
import { CalendarDays, CircleUser, Magnifier, UserArrowRight } from '@/components/ui/icons/nucleo';
import { cn } from '@/lib/cn';

import { playerTabs, type PlayerChromeKind, type PlayerTabIconKey } from './nav-items';
import { PlayerUserMenu } from './player-user-menu';
import { useSaveData } from './PublicPrefetchLink';

/**
 * The player's bottom tab bar, below `md` (T20; owner decision 3).
 *
 *   signed out          Discover · Sign in
 *   player, coach, —    Discover · My bookings · Account
 *   club account        Discover · Account
 *
 * The tabs come from `nav-items.ts` (`playerTabs`), so `nav-hrefs-resolve`
 * follows every one to a page. inflect's sidebar shell is the club admin's;
 * a player on a phone gets what a native app gives them, a row under the
 * thumb, and the iOS client (/api/v1) has the same three.
 *
 * ═══ GEOMETRY ═══
 *
 * Each tab is at least 44 x 44 px (WCAG 2.5.5; the bar is 56 px tall), and
 * the bar pads itself by `env(safe-area-inset-bottom)` so the home indicator
 * never sits on a label. It is fixed, so an in-flow spacer of the same height
 * keeps the last row of a page from hiding under it, and it publishes that
 * height as `--app-bottom-inset` on <html> while it is showing: the Toaster
 * (providers.tsx) and ScrollToTop lift themselves by it.
 *
 * ═══ WHERE IT IS NOT ═══
 *
 * /login, /invite/* and /offline: a page whose whole job is one form or one
 * decision, where a Discover tab is a way to lose it.
 *
 * ═══ PREFETCH ═══
 *
 * Full (`prefetch={true}`), the one place docs/perf/navigation-policy.md
 * allows it (tests/guardrails/router-cache-policy.test.ts allow-lists this
 * file): the bar is always on screen, a tap on it is the commonest navigation
 * a phone makes, and a fully prefetched tab renders from the router cache
 * without React's 300 ms reveal throttle (#290). Under Save-Data it falls back
 * to the default, and the server render assumes Save-Data, so such a browser
 * never starts a full prefetch.
 *
 * ═══ THE ACCOUNT TAB ═══
 *
 * Not a page: it opens the vendored `UserMenu`, controlled, which presents as
 * the phone bottom sheet. The vendored menu brings its own avatar trigger and
 * has no slot for another, so the trigger is kept, `inert` and invisible,
 * over this tab: it anchors the dropdown the menu becomes from 640 px, and it
 * is never a second, nameless tab stop. Focus comes back to the tab on close.
 */
const HIDDEN_ON = [/^\/login(?:\/|$)/, /^\/invite\//, /^\/offline(?:\/|$)/];

/** 56 px of bar, plus the home indicator. Published as `--app-bottom-inset`. */
const BAR_HEIGHT = 'calc(3.5rem + env(safe-area-inset-bottom))';

const ICONS: Record<PlayerTabIconKey, ComponentType<SVGProps<SVGSVGElement>>> = {
  discover: Magnifier,
  bookings: CalendarDays,
  signIn: UserArrowRight,
  account: CircleUser,
};

const TAB_CLASS =
  'flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 text-[11px] leading-tight font-medium transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none';

export function isTabBarHidden(pathname: string): boolean {
  return HIDDEN_ON.some((re) => re.test(pathname));
}

function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function BottomTabBar({
  kind,
  identity,
}: {
  kind: PlayerChromeKind;
  identity: { name: string | null; email: string | null } | null;
}) {
  const t = useTranslations('common.nav');
  const pathname = usePathname() ?? '/';
  const saveData = useSaveData();
  const belowMd = useIsBelowMd();
  const hidden = isTabBarHidden(pathname);

  const [menuOpen, setMenuOpen] = useState(false);
  const accountRef = useRef<HTMLButtonElement>(null);
  // Whether the menu was open when the pointer went down on the tab. A
  // non-modal dropdown (640-767 px) closes itself on that pointerdown, as an
  // outside press, so by the click `menuOpen` is already false and a toggle
  // would open it again.
  const openAtPress = useRef(false);

  useEffect(() => {
    if (hidden || !belowMd) return;
    const root = document.documentElement;
    root.style.setProperty('--app-bottom-inset', BAR_HEIGHT);
    return () => {
      root.style.removeProperty('--app-bottom-inset');
    };
  }, [hidden, belowMd]);

  if (hidden) return null;

  const setOpen = (next: boolean) => {
    setMenuOpen(next);
    // The real trigger is inert, so the menu cannot hand focus back to it.
    if (!next) requestAnimationFrame(() => accountRef.current?.focus());
  };

  return (
    <>
      {/* Holds the page's last row clear of the fixed bar. */}
      <div aria-hidden="true" className="shrink-0 md:hidden" style={{ height: BAR_HEIGHT }} />
      <nav
        aria-label={t('tabBar')}
        data-testid="bottom-tab-bar"
        className="border-border-subtle bg-bg-page/95 fixed inset-x-0 bottom-0 z-30 flex border-t pr-[max(0.5rem,env(safe-area-inset-right))] pb-[env(safe-area-inset-bottom)] pl-[max(0.5rem,env(safe-area-inset-left))] backdrop-blur-sm md:hidden"
      >
        <ul className="flex h-14 w-full items-stretch gap-1 py-1.5">
          {playerTabs(kind).map((tab) => {
            const Icon = ICONS[tab.iconKey];
            if (tab.type === 'link') {
              const current = isCurrent(pathname, tab.href);
              return (
                <li key={tab.href} className="flex flex-1">
                  <Link
                    href={tab.href}
                    prefetch={saveData ? null : true}
                    aria-current={current ? 'page' : undefined}
                    className={cn(
                      TAB_CLASS,
                      current
                        ? 'text-content-emphasis'
                        : 'text-content-muted hover:text-content-default',
                    )}
                  >
                    <Icon className="size-5" aria-hidden="true" />
                    <span>{t(tab.labelKey)}</span>
                  </Link>
                </li>
              );
            }

            return (
              <li key="account" className="relative flex flex-1">
                <button
                  ref={accountRef}
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  data-testid="bottom-tab-account"
                  onPointerDown={() => {
                    openAtPress.current = menuOpen;
                  }}
                  onClick={(e) => {
                    // A keyboard click has no pointerdown before it.
                    const wasOpen = e.detail === 0 ? menuOpen : openAtPress.current;
                    openAtPress.current = false;
                    setOpen(!wasOpen);
                  }}
                  className={cn(
                    TAB_CLASS,
                    menuOpen
                      ? 'text-content-emphasis'
                      : 'text-content-muted hover:text-content-default',
                  )}
                >
                  <Icon className="size-5" aria-hidden="true" />
                  <span>{t(tab.labelKey)}</span>
                </button>
                {identity ? (
                  // `inert` alone: it removes the trigger from the tab order
                  // AND the accessibility tree. An `aria-hidden` over a
                  // focusable button is what axe's aria-hidden-focus flags.
                  <div
                    inert
                    className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0"
                  >
                    <PlayerUserMenu
                      name={identity.name}
                      email={identity.email}
                      open={menuOpen}
                      onOpenChange={setOpen}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
