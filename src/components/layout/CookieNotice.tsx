'use client';

import { useTranslations } from 'next-intl';
import { useSyncExternalStore } from 'react';

import { InlineNotice } from '@/components/ui/inline-notice';
import { TextLink } from '@/components/ui/typography';
import { uiStorageKey } from '@/lib/ui-storage';

/** Where the dismissal is kept: this browser's own note, nothing sent anywhere. */
export const COOKIE_NOTICE_KEY = uiStorageKey('cookie-notice');

const DISMISSED = 'dismissed';

/**
 * Dismissed in this tab when the browser keeps no storage (a private window, a
 * blocked origin): the notice then comes back on the next visit, which is the
 * honest outcome of having nowhere to write.
 */
let dismissedHere = false;
const listeners = new Set<() => void>();

function readDismissed(): boolean {
  if (dismissedHere) return true;
  try {
    return window.localStorage.getItem(COOKIE_NOTICE_KEY) === DISMISSED;
  } catch {
    return false;
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Dismissed in another tab: hide it here too.
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function dismiss(): void {
  dismissedHere = true;
  try {
    window.localStorage.setItem(COOKIE_NOTICE_KEY, DISMISSED);
  } catch {
    // Nowhere to keep it; hidden for this tab only (see `dismissedHere`).
  }
  for (const l of listeners) l();
}

/** For tests: forget a dismissal made in this module. */
export function __resetCookieNoticeForTests(): void {
  dismissedHere = false;
}

/**
 * "playerz.bg uses only essential cookies" (#370, Q32): a small notice for a
 * visitor's first visit, not a consent banner.
 *
 * Essential-only, verified (the PR lists every cookie and storage key): the
 * session, CSRF and sign-in cookies, and the language and theme a visitor
 * chose. None needs consent, so there is nothing to accept or reject: the
 * notice says so, links to the cookie policy once the owner's text exists,
 * and can be dismissed. The dismissal is the visitor's choice, kept in
 * localStorage.
 *
 * ═══ WHERE IT SITS ═══
 *
 * Sticky to the bottom of the screen, at the end of the page, after the footer
 * and before the tab bar's spacer: while there is page below, it floats at the
 * bottom (bottom-left from `md`), under the overlays (z-30, as the tab bar);
 * at the end of the page it settles into its own room, so nothing (the
 * footer's language switch, the contact form) is ever left beneath it. Fixed
 * would cover the end of the page with no way to scroll it clear.
 *
 * On a phone it stands above the bottom tab bar, offset by
 * `--app-bottom-inset` (the bar publishes its height there, as the toaster
 * reads it), so it never covers a tab; its bottom margin equals that offset's
 * own gap, so at the end of the page it sits exactly where it floated.
 * Mounted by the signed-out public chrome only (`PlayerChrome`): a visitor's
 * frame, never a shell.
 *
 * ═══ NO FLASH ═══
 *
 * Nobody knows on the server whether this browser dismissed it, so the server
 * renders nothing and the client decides after hydration
 * (`useSyncExternalStore`, server snapshot "dismissed"). A visitor who
 * dismissed it never sees it flicker; a first-time visitor sees it appear at
 * the end of the page, below everything they are looking at. On a page shorter
 * than the screen the footer moves up to make its room: the price of never
 * covering the end of the page, paid once, until it is dismissed.
 */
export function CookieNotice({ cookiesHref }: { cookiesHref: string | null }) {
  const t = useTranslations('common.cookieNotice');
  const dismissed = useSyncExternalStore(subscribe, readDismissed, () => true);
  if (dismissed) return null;

  return (
    // The notice's own tint is translucent: the elevated surface under it
    // keeps the page from showing through while it floats.
    <div
      className="bg-bg-elevated sticky bottom-[calc(var(--app-bottom-inset,0px)+0.75rem)] z-30 mx-4 mb-3 rounded-lg shadow-lg md:bottom-6 md:mr-auto md:mb-6 md:ml-6 md:max-w-sm"
      data-testid="cookie-notice"
    >
      <InlineNotice variant="info" onDismiss={dismiss} dismissLabel={t('dismiss')}>
        <span>{t('text')}</span>
        {cookiesHref ? (
          <>
            {' '}
            <TextLink tone="link" href={cookiesHref} className="inline">
              {t('more')}
            </TextLink>
          </>
        ) : null}
      </InlineNotice>
    </div>
  );
}
