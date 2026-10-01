'use client';

/**
 * The app-wide client providers, mounted ONCE by the root layout.
 *
 * ═══ WHY THIS FILE EXISTS ═══
 *
 * The root layout used to mount NextIntlClientProvider and ThemeProvider and
 * nothing else. Every ported primitive that needs more than that was quietly
 * broken outside /design-system (which wraps itself in its own TooltipProvider):
 *
 *   - Tooltip — Radix THROWS "`Tooltip` must be used within `TooltipProvider`"
 *     on the first render, so the desktop close button of every <Modal> took the
 *     page down with it.
 *   - toast() — sonner only renders into a mounted <Toaster>. Without one every
 *     useToast() / CopyButton confirmation was a silent no-op.
 *   - useKeyboardShortcut() — falls back to a no-op registry outside
 *     KeyboardShortcutProvider, so Escape-to-clear on a table selection and the
 *     date-range picker's shortcuts did nothing.
 *
 *   - SWR — nothing read `/api/v1` through a shared cache. DataProvider
 *     (src/lib/data/provider.tsx) is the one SWRConfig: its middleware stops
 *     every revalidation once the session expires or the signed-in account
 *     changes, and it never persists anything.
 *
 * ═══ ORDER, OUTERMOST FIRST ═══
 *
 * DataProvider → ThemeProvider → KeyboardShortcutProvider → TooltipProvider →
 * MotionConfig. DataProvider is outermost because it renders nothing and any
 * provider's subtree may read data; it is a plain context, so its position
 * costs nothing.
 * The Toaster sits INSIDE ThemeProvider so it can follow the theme, and after
 * the children so it paints above page content (it portals nothing — sonner
 * renders a fixed <section> in place).
 *
 * NextIntlClientProvider must stay OUTSIDE this component (see layout.tsx): the
 * Toaster's container label is translated here, and so are the primitives the
 * providers render around.
 */

import { MotionConfig } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useEffect, type ReactNode } from 'react';
import { Toaster } from 'sonner';

import { SessionExpiredNotice } from '@/components/layout/session-expired-notice';
import { ThemeProvider, useTheme } from '@/components/theme/ThemeProvider';
import { useIsBelowMd } from '@/components/ui/hooks/use-is-below-md';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DataProvider } from '@/lib/data/provider';
import { ViewerChangedNotice } from '@/lib/data/viewer-changed-notice';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';

/**
 * Keep `<meta name="theme-color">` on the ACTIVE theme, not the OS one.
 *
 * The layout's themeColor is a media-keyed pair, so the browser picks by
 * `prefers-color-scheme`. A visitor who chose light on a dark-mode phone would
 * get a dark status bar over a light page — the exact seam the pair exists to
 * avoid. The pre-paint script fixes the first paint; this follows every later
 * flip (the toggle, another tab's cookie on the next navigation).
 *
 * It watches the ATTRIBUTE rather than useTheme(): ThemeProvider's state starts
 * at 'dark' and only settles in its mount effect, which runs AFTER this child's
 * effect — reacting to the state would paint one dark frame of chrome for every
 * light user. The attribute is already correct (SSR cookie or pre-paint script).
 *
 * The colour is read from the resolved `--bg-page` token, so there is no second
 * copy of the palette to drift.
 */
function useThemeColorMetaSync() {
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      const colour = getComputedStyle(root).getPropertyValue('--bg-page').trim();
      if (!colour) return;
      for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
        meta.setAttribute('content', colour);
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
}

/**
 * The global toast host.
 *
 * Bottom-centre below md, where the thumb is and where a top toast would sit
 * under the notch; top-right from md, where inflect puts it. The bottom offset
 * adds `--app-bottom-inset` (0px until the player tab bar sets it) so a toast
 * never lands on top of the bar. sonner switches to its own full-width mobile
 * layout below 600px and reads `mobileOffset` there, so both offsets carry it.
 */
function AppToaster() {
  const t = useTranslations('common.ui');
  const { theme } = useTheme();
  const belowMd = useIsBelowMd();

  return (
    <Toaster
      theme={theme}
      position={belowMd ? 'bottom-center' : 'top-right'}
      offset={{ bottom: 'calc(24px + var(--app-bottom-inset, 0px))' }}
      mobileOffset={{ bottom: 'calc(16px + var(--app-bottom-inset, 0px))' }}
      containerAriaLabel={t('notifications')}
      richColors
      closeButton
      duration={3000}
    />
  );
}

function ThemeColorMetaSync() {
  useThemeColorMetaSync();
  return null;
}

/**
 * The two "stop, this page is out of date" notices, mounted once.
 *
 * inflect's SessionExpiredNotice is vendored as shipped, and it is fixed at
 * `top-0` with 12 px of padding — under the notch on an installed iPhone PWA.
 * Its class list cannot change here (it is hash-locked to inflect), so the
 * notch is added from outside: `display: contents` keeps this wrapper out of
 * layout, and the child selector — an id beats a utility class — tops up the
 * notice's own padding with the safe-area inset. The viewer notice is playerz's
 * own and pads itself the same way.
 */
function StaleNotices() {
  return (
    <div className="contents [&>#session-expired-notice]:pt-[calc(0.75rem+env(safe-area-inset-top))]">
      <SessionExpiredNotice />
      <ViewerChangedNotice />
    </div>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <DataProvider>
      <ThemeProvider>
        <ThemeColorMetaSync />
        <KeyboardShortcutProvider>
          <TooltipProvider>
            {/*
             * reducedMotion="user": every motion/react animation (the table, the
             * charts, AnimatedSizeContainer) drops its transform/layout animation
             * when the OS asks for reduced motion. globals.css flattens CSS
             * durations, but it cannot reach a JS-driven spring — this is the JS
             * half of the same promise (tests/guardrails/motion-safety.test.ts).
             */}
            <MotionConfig reducedMotion="user">
              <StaleNotices />
              {children}
              <AppToaster />
            </MotionConfig>
          </TooltipProvider>
        </KeyboardShortcutProvider>
      </ThemeProvider>
    </DataProvider>
  );
}
