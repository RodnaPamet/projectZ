'use client';

import { useTranslations } from 'next-intl';
import { useDeferredValue, useEffect, useState } from 'react';

import type { PlayerCardDto as PlayerCard } from '@/app/api/v1/_lib/messaging';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { UserSearch } from '@/components/ui/icons/nucleo';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { CardListSkeleton } from '@/components/loading/shapes';
import { Caption } from '@/components/ui/typography';
import { KEYS } from '@/lib/data/keys';
import { useV1SWR } from '@/lib/data/use-v1-swr';

import { PlayerCardView } from './PlayerCardView';

/** The fewest characters the server searches on (`PLAYER_SEARCH_MIN`). */
const MIN = 2;
/** How long typing must pause before the name is looked up. */
const SETTLE_MS = 300;

/**
 * "Ново съобщение" (#375): find a player by name, see their public card, write.
 *
 * Everyone is findable unless they switched off "Показвай ме в търсенето" in
 * their profile; nobody in a block with the caller is. The lookup waits for a
 * pause in typing and for two characters, and each answer is the public card
 * only (name, picture, sports with levels). Choosing a row shows that card,
 * with "Пиши".
 */
export function PlayerSearch() {
  const t = useTranslations('messaging.search');
  const [q, setQ] = useState('');
  const [settled, setSettled] = useState('');
  const [chosen, setChosen] = useState<PlayerCard | null>(null);
  const deferred = useDeferredValue(q);

  useEffect(() => {
    const id = window.setTimeout(() => setSettled(deferred.trim()), SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [deferred]);

  const key = settled.length >= MIN ? KEYS.players(settled) : null;
  const { data, error, isLoading } = useV1SWR<PlayerCard[]>(key, { revalidateOnFocus: false });

  return (
    <div className="gap-section flex flex-col">
      <Input
        type="search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setChosen(null);
        }}
        placeholder={t('placeholder')}
        aria-label={t('placeholder')}
        autoComplete="off"
        maxLength={80}
        data-testid="player-search-input"
      />

      {chosen ? <PlayerCardView card={chosen} /> : null}

      {key === null ? (
        <Caption>{t('hint', { min: MIN })}</Caption>
      ) : isLoading && !data ? (
        <CardListSkeleton rows={3} lines={1} className="gap-compact" />
      ) : error ? (
        <InlineNotice variant="error">{t('error')}</InlineNotice>
      ) : (data ?? []).length === 0 ? (
        <EmptyState
          icon={UserSearch}
          size="sm"
          title={t('none')}
          description={t('noneBody')}
          data-testid="player-search-empty"
        />
      ) : (
        <Card elevation="flat" density="none">
          <ul className="divide-border-subtle divide-y" data-testid="player-search-results">
            {(data ?? []).map((p) => {
              const name = p.name ?? t('unnamed');
              return (
                <li key={p.userId}>
                  <button
                    type="button"
                    className="hover:bg-bg-muted flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:outline-none focus-visible:ring-inset"
                    aria-pressed={chosen?.userId === p.userId}
                    onClick={() => setChosen(p)}
                    data-testid="player-search-row"
                  >
                    <InitialsAvatar value={name} imageUrl={p.avatarUrl} />
                    <span className="text-content-default min-w-0 flex-1 truncate text-sm">
                      {name}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
