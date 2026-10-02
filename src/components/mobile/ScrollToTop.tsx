'use client';

import { ArrowUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/cn';
import { haptic } from '@/lib/haptics';
import { scrollBehavior, usePrefersReducedMotion } from '@/lib/hooks/use-reduced-motion';

/**
 * Jump back to the top of a long list.
 *
 * ─── Why it appears LATE ─────────────────────────────────────────────
 *
 * After roughly two screens of scrolling — not immediately.
 *
 * A button that is always there is a button permanently covering the
 * bottom-right corner of every page, including the ones you can see the top of.
 * It costs a thumb's worth of content to solve a problem the user does not have
 * yet.
 *
 * Two screens is the point at which flicking back up stops being trivial.
 */
const APPEAR_AFTER_SCREENS = 2;

export function ScrollToTop({ className }: { className?: string }) {
  const t = useTranslations('common');
  const [visible, setVisible] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const onScroll = () => {
      setVisible(window.scrollY > window.innerHeight * APPEAR_AFTER_SCREENS);
    };

    onScroll();

    // Passive: we only read. Without it the browser must wait for this handler
    // before it can scroll, and every flick judders.
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={() => {
        haptic('tap');
        window.scrollTo({
          top: 0,
          // A smooth scroll is the browser's own behaviour, not a CSS transition
          // — the global reduced-motion override cannot reach it. Flinging a
          // reduced-motion user through two screens of content is exactly what
          // they asked us not to do.
          behavior: scrollBehavior(prefersReducedMotion),
        });
      }}
      aria-label={t('scrollToTop')}
      className={cn(
        // 44px. Anything smaller is a target people miss, and a miss here scrolls
        // the list instead — the opposite of what they wanted.
        'fixed right-4 z-30 flex size-11 items-center justify-center rounded-full',
        'bg-bg-elevated text-content-emphasis border-border-strong border shadow-lg',
        'hover:bg-bg-muted transition-colors',
        // Sits above the safe area, so it is not under the home indicator on a
        // notched phone — and above the player tab bar (T20), which publishes
        // its height, home indicator included, as --app-bottom-inset while it
        // shows. max(): with no tab bar the variable is unset (0px) and the
        // safe area is the floor, as before.
        'bottom-[calc(1rem+max(var(--app-bottom-inset,0px),env(safe-area-inset-bottom)))]',
        className,
      )}
    >
      <ArrowUp className="size-5" aria-hidden />
    </button>
  );
}
