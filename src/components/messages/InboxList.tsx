'use client';

import Link from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';

import type { ConversationSummaryDto } from '@/app/api/v1/_lib/messaging';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Msgs } from '@/components/ui/icons/nucleo';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineNotice } from '@/components/ui/inline-notice';
import { CardListSkeleton } from '@/components/loading/shapes';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption } from '@/components/ui/typography';
import { KEYS, type InboxSide, type V1Page } from '@/lib/data/keys';
import { needsSkeleton, useV1SWRInfinite } from '@/lib/data/use-v1-swr';
import { INBOX_REFRESH_MS } from '@/lib/messaging/limits';

/**
 * An inbox (#375), ported from Agrent's `ThreadsClient`: the newest
 * conversation first, each with who it is with, the start of the last message,
 * when, and how many the reader has not read.
 *
 * Seeded by the page, then held under the endpoint's own key and re-read every
 * 30 seconds while visible: one indexed, capped read. "Покажи още" follows the
 * cursor. The same list serves a player's two tabs and a club's shared inbox
 * (`side`); the server decides what is in each.
 */
export function InboxList({
  side,
  tab = 'conversations',
  seed,
  hrefFor,
  emptyAction,
}: {
  side: InboxSide;
  tab?: 'conversations' | 'requests';
  seed?: V1Page<ConversationSummaryDto>;
  hrefFor: (id: string) => string;
  /** The empty list's way forward ("Ново съобщение"), if any. */
  emptyAction?: { label: string; href: string };
}) {
  const t = useTranslations('messaging.inbox');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  // "Today" moves on while the list is open; a minute is fine enough.
  const now = useNow({ updateInterval: 60_000 }).getTime();

  const getKey = KEYS.conversations(side, side.kind === 'me' ? { tab } : {});
  const list = useV1SWRInfinite<ConversationSummaryDto>(getKey, {
    fallbackData: seed ? [seed] : undefined,
    refreshInterval: INBOX_REFRESH_MS,
  });

  if (needsSkeleton(list)) return <CardListSkeleton rows={4} lines={2} className="gap-compact" />;

  const pages = list.data ?? [];
  const items = pages.flatMap((p) => p.items);
  const more = pages.at(-1)?.nextCursor != null;

  if (list.error && items.length === 0) {
    return (
      <InlineNotice variant="error" data-testid="inbox-error">
        {t('error')}
      </InlineNotice>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Msgs}
        title={tab === 'requests' ? t('emptyRequests') : t('empty')}
        description={tab === 'requests' ? t('emptyRequestsBody') : t('emptyBody')}
        primaryAction={
          emptyAction ? { label: emptyAction.label, href: emptyAction.href } : undefined
        }
        data-testid="inbox-empty"
      />
    );
  }

  return (
    <div className="gap-compact flex flex-col">
      <Card elevation="flat" density="none">
        <ul className="divide-border-subtle divide-y" data-testid="inbox-list">
          {items.map((c) => {
            const name =
              c.counterpart.kind === 'club'
                ? c.counterpart.name
                : c.counterpart.deleted
                  ? tCommon('deletedUser')
                  : (c.counterpart.name ?? t('unnamed'));
            const at = new Date(c.lastMessageAt);
            const sameDay = now - at.getTime() < 20 * 3_600_000;
            const preview = c.lastMessage
              ? c.lastMessage.deleted
                ? t('deleted')
                : `${c.lastMessage.mine ? `${t('you')}: ` : ''}${c.lastMessage.preview ?? ''}`
              : '';
            return (
              <li key={c.id}>
                <Link
                  href={hrefFor(c.id)}
                  className="hover:bg-bg-muted flex min-h-16 items-center gap-3 px-4 py-3 transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none focus-visible:ring-inset"
                  data-testid="inbox-row"
                >
                  <InitialsAvatar
                    value={name}
                    imageUrl={c.counterpart.kind === 'player' ? c.counterpart.avatarUrl : null}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span
                        className={`truncate text-sm ${c.unreadCount > 0 ? 'text-content-emphasis font-semibold' : 'text-content-default'}`}
                      >
                        {name}
                      </span>
                      {c.state === 'pending' ? (
                        <StatusBadge variant="neutral" size="sm" icon={null}>
                          {t('pending')}
                        </StatusBadge>
                      ) : c.state === 'blocked' ? (
                        <StatusBadge variant="warning" size="sm" icon={null}>
                          {t('blocked')}
                        </StatusBadge>
                      ) : null}
                      <Caption className="ml-auto shrink-0">
                        <time dateTime={c.lastMessageAt}>
                          {format.dateTime(
                            at,
                            sameDay
                              ? { hour: '2-digit', minute: '2-digit' }
                              : { day: 'numeric', month: 'short' },
                          )}
                        </time>
                      </Caption>
                    </div>
                    <div className="flex items-center gap-2">
                      <Caption className="flex-1 truncate">{preview}</Caption>
                      {c.unreadCount > 0 ? (
                        <StatusBadge
                          variant="neutral"
                          tone="solid"
                          size="sm"
                          icon={null}
                          className="bg-bg-accent text-content-accent shrink-0 tabular-nums"
                          aria-label={t('unread', { count: c.unreadCount })}
                          data-testid="inbox-unread"
                        >
                          {c.unreadCount > 99 ? '99+' : c.unreadCount}
                        </StatusBadge>
                      ) : null}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
      {more ? (
        <Button
          type="button"
          variant="secondary"
          className="self-start"
          loading={list.isValidating && list.size > pages.length}
          onClick={() => void list.setSize(list.size + 1)}
          data-testid="inbox-more"
        >
          {t('more')}
        </Button>
      ) : null}
    </div>
  );
}
