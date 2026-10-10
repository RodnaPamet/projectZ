'use client';

import { useTranslations } from 'next-intl';

import { StatusBadge } from '@/components/ui/status-badge';
import { KEYS, type InboxSide } from '@/lib/data/keys';
import { useV1SWR } from '@/lib/data/use-v1-swr';
import { INBOX_REFRESH_MS } from '@/lib/messaging/limits';

/** As the bell's: one or two characters, so the badge never outgrows the icon. */
const badgeLabel = (count: number) => (count > 9 ? '9+' : String(count));

/**
 * The count on the top bar's messages icon (#375): how many conversations
 * (and requests) have something unread. Its own chunk, as the bell is, so the
 * shell's first load does not carry its read; the icon itself is drawn at once
 * by `HeaderActions`. Re-read every 30 seconds while the tab is visible; a
 * failed read shows no badge, which is better than a wrong one. A screen
 * reader hears the count after the link's name.
 */
export function MessagesBadge({ side }: { side: InboxSide }) {
  const t = useTranslations('common.nav');
  const { data } = useV1SWR<{ conversations: number; requests: number }>(
    KEYS.conversationsUnread(side),
    { refreshInterval: INBOX_REFRESH_MS },
  );
  const unread = (data?.conversations ?? 0) + (data?.requests ?? 0);
  if (unread === 0) return null;

  return (
    <>
      <span className="sr-only">{t('messagesUnread', { count: unread })}</span>
      {/* The bell's accent badge (#362): a count is a highlight, not a failure. */}
      <StatusBadge
        variant="neutral"
        tone="solid"
        size="sm"
        icon={null}
        aria-hidden="true"
        className="bg-bg-accent text-content-accent pointer-events-none absolute -top-1 -right-1 min-w-4 justify-center px-1 tabular-nums"
        data-testid="messages-count"
      >
        {badgeLabel(unread)}
      </StatusBadge>
    </>
  );
}
