'use client';

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';

import { isViewerChanged, subscribeViewerChanged } from './viewer';

/**
 * The notice for a tab whose account changed underneath it (#263).
 *
 * Shaped like inflect's `SessionExpiredNotice` (mounted beside it in
 * src/app/providers.tsx) and for the same reasons: one notice for the whole
 * app however many hooks saw the 409, and an offer rather than a redirect — a
 * half-typed review is not thrown away by a background revalidation.
 *
 * The action is a full reload of this URL, not a client navigation: the page,
 * its server-rendered viewer id and every SWR key must be rebuilt for the
 * account that is signed in now, and only a document load starts all of them
 * from nothing. playerz-owned (no inflect counterpart), so it lives here.
 *
 * The top padding is the notice's own 12 px (`compact`) plus the notch: it is
 * fixed at the very top, where an installed PWA draws under the status bar.
 */

const serverSnapshot = () => false;

/** `reload` is injectable only because jsdom's `location.reload` cannot be spied on. */
export function ViewerChangedNotice({
  reload = () => window.location.reload(),
}: {
  reload?: () => void;
}) {
  const t = useTranslations('panels.viewerChanged');
  const changed = useSyncExternalStore(subscribeViewerChanged, isViewerChanged, serverSnapshot);

  if (!changed) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      id="viewer-changed-notice"
      className="gap-compact border-border-subtle bg-bg-elevated px-default pb-compact text-content-default fixed inset-x-0 top-0 z-[100] flex flex-wrap items-center justify-center border-b pt-[calc(0.75rem+env(safe-area-inset-top))] text-sm shadow-sm"
    >
      <span>{t('body')}</span>
      <button
        type="button"
        onClick={reload}
        className="text-content-brand font-medium underline underline-offset-2"
      >
        {t('action')}
      </button>
    </div>
  );
}
