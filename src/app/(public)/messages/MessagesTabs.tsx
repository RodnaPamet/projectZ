'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import type { ConversationSummaryDto } from '@/app/api/v1/_lib/messaging';
import { InboxList } from '@/components/messages/InboxList';
import { StatusBadge } from '@/components/ui/status-badge';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { KEYS, type V1Page } from '@/lib/data/keys';
import { useV1SWR } from '@/lib/data/use-v1-swr';
import { INBOX_REFRESH_MS } from '@/lib/messaging/limits';

import { INBOX_TABS, inboxTabFrom, type InboxTab } from './tabs';

const ME = { kind: 'me' } as const;

/**
 * Разговори and «Заявки» (#375): two lists under one toggle, as /me/bookings
 * has Предстоящи and Минали. The server seeds the tab the page was opened on;
 * switching is client state, and the address follows (`?tab=requests`) with
 * `history.replaceState`, so a reload opens the same tab. «Заявки» carries how
 * many requests have something unread.
 */
export function MessagesTabs({
  initialTab,
  seed,
}: {
  initialTab: InboxTab;
  seed: V1Page<ConversationSummaryDto>;
}) {
  const t = useTranslations('messaging');
  const [tab, setTab] = useState<InboxTab>(initialTab);
  const { data: unread } = useV1SWR<{ conversations: number; requests: number }>(
    KEYS.conversationsUnread(ME),
    { refreshInterval: INBOX_REFRESH_MS },
  );

  function pick(next: string) {
    const value = inboxTabFrom(next);
    setTab(value);
    const url = new URL(window.location.href);
    if (value === 'conversations') url.searchParams.delete('tab');
    else url.searchParams.set('tab', value);
    window.history.replaceState(window.history.state, '', url);
  }

  return (
    <div className="gap-section grid">
      <ToggleGroup
        ariaLabel={t('tabs.label')}
        options={INBOX_TABS.map((value) => ({
          value,
          label: t(`tabs.${value}`),
          badge:
            value === 'requests' && (unread?.requests ?? 0) > 0 ? (
              <StatusBadge
                variant="neutral"
                tone="solid"
                size="sm"
                icon={null}
                className="bg-bg-accent text-content-accent tabular-nums"
                data-testid="messages-requests-count"
              >
                {unread!.requests}
              </StatusBadge>
            ) : undefined,
        }))}
        selected={tab}
        selectAction={pick}
        className="self-start justify-self-start"
        optionClassName="min-h-11 whitespace-nowrap"
      />

      <InboxList
        key={tab}
        side={ME}
        tab={tab}
        seed={tab === initialTab ? seed : undefined}
        hrefFor={(id) => `/messages/${id}`}
        emptyAction={
          tab === 'conversations' ? { label: t('tabs.new'), href: '/messages/new' } : undefined
        }
      />
    </div>
  );
}
