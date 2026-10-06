'use client';

import Link from 'next/link';
import {
  forwardRef,
  useEffect,
  type ButtonHTMLAttributes,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from 'react';

import { useIsBelowMd } from '@/components/ui/hooks/use-is-below-md';
import { cn } from '@/lib/cn';

/**
 * The one bottom tab bar, below `md`: shared by the player chrome
 * (`BottomTabBar`) and the club admin (`ClubAdminTabBar`), #362.
 *
 * The geometry is the player bar's (T20). The active cue and the way tabs are
 * chosen follow agrent's `BottomTabBar` (RodnaPamet/agri-saas, on the same
 * upstream shell), as the owner directed on #362:
 *
 *   - `md:hidden`, fixed to the bottom, z-30 (under the drawer and modals);
 *   - every tab at least 44 x 44 px (WCAG 2.5.5; the bar is 56 px tall);
 *   - `aria-current="page"` on the active link AND a top accent bar, so the
 *     active state is never colour alone (WCAG 1.4.1);
 *   - padded by `env(safe-area-inset-bottom)`, so the home indicator never
 *     sits on a label, and publishing its height as `--app-bottom-inset`
 *     while it shows, so the Toaster and ScrollToTop lift above it.
 *
 * Only the chrome lives here. Which tabs a bar shows is its caller's business:
 * the player's come from `playerTabs`, the club admin's are RESOLVED from the
 * permission-filtered sections its sidebar renders.
 *
 * ═══ PREFETCH (T30, docs/perf/navigation-policy.md) ═══
 *
 * The bottom tab bar is the one place a full prefetch is allowed, and only the
 * PLAYER bar asks for it, through `fullPrefetch` (never under Save-Data). The
 * admin bar's tabs prefetch the default way, down to each route's loading
 * boundary, like every other admin link. `router-cache-policy` allow-lists
 * this file for the one `prefetch` it forwards, and pins `fullPrefetch` to
 * `BottomTabBar.tsx`.
 */

/** 56 px of bar, plus the home indicator. */
export const TAB_BAR_HEIGHT = 'calc(3.5rem + env(safe-area-inset-bottom))';

const TAB_CLASS =
  'relative flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 text-[11px] leading-tight font-medium transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none';

type Glyph = ComponentType<SVGProps<SVGSVGElement>>;

function tabClass(active: boolean) {
  return cn(
    TAB_CLASS,
    active ? 'text-content-emphasis' : 'text-content-muted hover:text-content-default',
  );
}

/** The non-colour active cue: a short bar along the tab's top edge. */
function ActiveAccent({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <span
      aria-hidden="true"
      data-tab-accent
      className="absolute inset-x-3 -top-1.5 h-0.5 rounded-full bg-[var(--brand-default)]"
    />
  );
}

function TabContent({ icon: Icon, label }: { icon: Glyph; label: string }) {
  return (
    <>
      <Icon className="size-5" aria-hidden="true" />
      <span className="max-w-full truncate">{label}</span>
    </>
  );
}

export function TabBar({
  label,
  testId = 'bottom-tab-bar',
  spacer = true,
  children,
}: {
  /** The nav landmark's accessible name. */
  label: string;
  testId?: string;
  /**
   * Render the in-flow spacer that keeps a page's last row clear of the bar.
   * Off when the caller reserves the room itself: the admin shell mounts the
   * bar from its top-chrome slot, which is not at the end of the page.
   */
  spacer?: boolean;
  children: ReactNode;
}) {
  const belowMd = useIsBelowMd();

  useEffect(() => {
    if (!belowMd) return;
    const root = document.documentElement;
    root.style.setProperty('--app-bottom-inset', TAB_BAR_HEIGHT);
    return () => {
      root.style.removeProperty('--app-bottom-inset');
    };
  }, [belowMd]);

  return (
    <>
      {spacer ? <TabBarSpacer /> : null}
      <nav
        aria-label={label}
        data-testid={testId}
        className="border-border-subtle bg-bg-page/95 fixed inset-x-0 bottom-0 z-30 flex border-t pr-[max(0.5rem,env(safe-area-inset-right))] pb-[env(safe-area-inset-bottom)] pl-[max(0.5rem,env(safe-area-inset-left))] backdrop-blur-sm md:hidden"
      >
        <ul className="flex h-14 w-full items-stretch gap-1 py-1.5">{children}</ul>
      </nav>
    </>
  );
}

/** Holds a page's last row clear of the fixed bar. */
export function TabBarSpacer() {
  return (
    <div aria-hidden="true" className="shrink-0 md:hidden" style={{ height: TAB_BAR_HEIGHT }} />
  );
}

export function TabBarLink({
  href,
  icon,
  label,
  current,
  fullPrefetch = false,
  testId,
}: {
  href: string;
  icon: Glyph;
  label: string;
  current: boolean;
  /**
   * Prefetch the whole page rather than down to its loading boundary. Only
   * the player bar sets it, and never under Save-Data (see the file comment).
   */
  fullPrefetch?: boolean;
  testId?: string;
}) {
  return (
    <li className="flex flex-1">
      <Link
        href={href}
        prefetch={fullPrefetch ? true : null}
        aria-current={current ? 'page' : undefined}
        data-active={current ? 'true' : 'false'}
        data-testid={testId}
        className={tabClass(current)}
      >
        <ActiveAccent active={current} />
        <TabContent icon={icon} label={label} />
      </Link>
    </li>
  );
}

/**
 * A tab that is not a page: it opens something (the club admin's drawer).
 * Painted while what it opens is open, but with no accent: it is not a place.
 */
export const TabBarButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
    icon: Glyph;
    label: string;
    active: boolean;
  }
>(function TabBarButton({ icon, label, active, className, ...rest }, ref) {
  return (
    <li className="relative flex flex-1">
      <button ref={ref} type="button" className={cn(tabClass(active), className)} {...rest}>
        <TabContent icon={icon} label={label} />
      </button>
    </li>
  );
});
