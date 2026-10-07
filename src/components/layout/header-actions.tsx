'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Bell } from '@/components/ui/icons/nucleo';
import { ViewerScope } from '@/lib/data/provider';

/**
 * The bell is its own chunk (#367): the shell is on every signed-in page, and
 * the bell's reads, writes and list would otherwise be in every page's first
 * load (measured: +15 KB gzip on `/`). Until it arrives, the same vendored
 * icon button stands in its place, with no count, so nothing moves.
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
 * The player shell's top-bar icons, before the account menu (#362): the bell.
 *
 * `NotificationBell` (#367): the unread count on the icon, the list in the
 * vendored `Popover` (a bottom sheet on a phone, a dropdown from `sm`). Its
 * reads go to `/api/v1` under `ViewerScope`, so a tab that outlives a switch
 * of account is told so rather than shown the other person's bell (T15).
 *
 * The vendored ghost icon button (`size="icon"`: 28 px drawn, 44 px under a
 * coarse pointer), named for a screen reader, the glyph hidden. Messages are
 * a sidebar item (Съобщения), shown when their module is on (#375).
 */
export function HeaderActions({ viewerId }: { viewerId: string }) {
  return (
    <div className="flex items-center gap-1">
      <ViewerScope viewerId={viewerId}>
        <NotificationBell />
      </ViewerScope>
    </div>
  );
}
