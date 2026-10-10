'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button, buttonVariants } from '@/components/ui/button';
import { Bell, Msgs } from '@/components/ui/icons/nucleo';
import { cn } from '@/lib/cn';
import type { InboxSide } from '@/lib/data/keys';
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

const MessagesBadge = dynamic(
  () => import('./messages-badge').then((m) => ({ default: m.MessagesBadge })),
  { loading: () => null },
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
 * coarse pointer), named for a screen reader, the glyph hidden.
 *
 * Messages (#375): when their module is on, an icon before the bell links to
 * the inbox — the player's own, or the club's for a club account — with how
 * much is unread. Its own chunk too, behind the same icon without a count.
 */
/** Where the messages icon leads (#375): an inbox and the API side it reads its count from. */
export interface HeaderMessages {
  href: string;
  side: InboxSide;
}

export function HeaderActions({
  viewerId,
  messages = null,
}: {
  viewerId: string;
  /** The inbox the icon opens, or null while the module is off. */
  messages?: HeaderMessages | null;
}) {
  const t = useTranslations('common.nav');
  return (
    <div className="flex items-center gap-1">
      <ViewerScope viewerId={viewerId}>
        {messages ? (
          <Link
            href={messages.href}
            className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'relative')}
            data-testid="header-messages"
          >
            <Msgs aria-hidden="true" />
            <span className="sr-only">{t('messages')}</span>
            <MessagesBadge side={messages.side} />
          </Link>
        ) : null}
        <NotificationBell />
      </ViewerScope>
    </div>
  );
}
