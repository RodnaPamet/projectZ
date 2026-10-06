'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Bell, Msgs } from '@/components/ui/icons/nucleo';
import { ViewerScope } from '@/lib/data/provider';

import { MODULE_HREFS } from './nav-items';

/**
 * The bell is its own chunk (#367): the header is on every page, and the
 * bell's reads, writes and list would otherwise be in every page's first load
 * (measured: +15 KB gzip on `/`). Until it arrives, the same vendored icon
 * button stands in its place, with no count, so nothing moves.
 */
function BellPlaceholder() {
  const t = useTranslations('common.nav');
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t('notifications')}
      icon={<Bell aria-hidden="true" />}
      data-testid="header-notifications"
    />
  );
}

const NotificationBell = dynamic(
  () => import('./notification-bell').then((m) => ({ default: m.NotificationBell })),
  { loading: () => <BellPlaceholder /> },
);

/**
 * The player header's icons, before the account menu (#362): messages and
 * the bell, the owner's direction for the player chrome.
 *
 * ═══ MESSAGES WAIT FOR THEIR MODULE ═══
 *
 * The icon is drawn only when `modules.messaging` is on (module 1, #375), so
 * nothing links to a page that is not there. Switching the module on is an
 * environment change (`MODULE_MESSAGING=1`), not a code change.
 *
 * ═══ THE BELL ═══
 *
 * `NotificationBell` (#367): the unread count on the icon, the list in the
 * vendored `Popover` (a bottom sheet on a phone, a dropdown from `sm`). Its
 * reads go to `/api/v1` under `ViewerScope`, so a tab that outlives a switch
 * of account is told so rather than shown the other person's bell (T15).
 *
 * Both are the vendored ghost icon button (`size="icon"`: 28 px drawn, 44 px
 * under a coarse pointer), named for a screen reader, the glyph hidden.
 */
export function HeaderActions({
  messaging,
  viewerId,
}: {
  messaging: boolean;
  /** The signed-in user the page was rendered for. */
  viewerId?: string | null;
}) {
  const t = useTranslations('common.nav');

  return (
    <div className="flex items-center gap-1">
      {messaging ? (
        <Link
          href={MODULE_HREFS.messaging}
          aria-label={t('messages')}
          className={buttonVariants({ variant: 'ghost', size: 'icon' })}
          data-testid="header-messages"
        >
          <Msgs aria-hidden="true" />
        </Link>
      ) : null}
      {viewerId ? (
        <ViewerScope viewerId={viewerId}>
          <NotificationBell />
        </ViewerScope>
      ) : (
        <NotificationBell />
      )}
    </div>
  );
}
