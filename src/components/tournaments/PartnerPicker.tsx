'use client';

import { useTranslations } from 'next-intl';
import { useDeferredValue, useEffect, useState } from 'react';

import type { PlayerCardDto as PlayerCard } from '@/app/api/v1/_lib/messaging';
import { Button } from '@/components/ui/button';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { Input } from '@/components/ui/input';
import { Caption } from '@/components/ui/typography';
import { KEYS } from '@/lib/data/keys';
import { useV1SWR } from '@/lib/data/use-v1-swr';

const MIN = 2;
const SETTLE_MS = 300;

/**
 * Who plays with you (#579, decision 50): a player found by name, as
 * messaging finds them (`GET /players?q=`). The partner is told and may
 * withdraw; nobody is asked first.
 */
export function PartnerPicker({
  chosen,
  onChoose,
}: {
  chosen: PlayerCard | null;
  onChoose: (player: PlayerCard | null) => void;
}) {
  const t = useTranslations('tournaments.partner');
  const [q, setQ] = useState('');
  const [settled, setSettled] = useState('');
  const deferred = useDeferredValue(q);

  useEffect(() => {
    const id = window.setTimeout(() => setSettled(deferred.trim()), SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [deferred]);

  const { data } = useV1SWR<PlayerCard[]>(settled.length >= MIN ? KEYS.players(settled) : null, {
    revalidateOnFocus: false,
  });

  if (chosen) {
    return (
      <div className="flex items-center gap-3" data-testid="partner-chosen">
        <InitialsAvatar value={chosen.name ?? '?'} imageUrl={chosen.avatarUrl} size="sm" />
        <span className="text-content-default min-w-0 flex-1 truncate text-sm">{chosen.name}</span>
        <Button type="button" size="sm" variant="ghost" onClick={() => onChoose(null)}>
          {t('change')}
        </Button>
      </div>
    );
  }

  return (
    <div className="gap-tight flex flex-col" data-testid="partner-picker">
      <Input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('placeholder')}
        aria-label={t('label')}
        data-testid="partner-search"
      />
      {settled.length >= MIN && data ? (
        data.length === 0 ? (
          <Caption>{t('none')}</Caption>
        ) : (
          <ul className="divide-border-subtle divide-y">
            {data.map((p) => (
              <li key={p.userId} className="flex items-center gap-3 py-2">
                <InitialsAvatar value={p.name ?? '?'} imageUrl={p.avatarUrl} size="sm" />
                <span className="text-content-default min-w-0 flex-1 truncate text-sm">
                  {p.name}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => onChoose(p)}
                  data-testid="partner-choose"
                >
                  {t('choose')}
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <Caption>{t('hint')}</Caption>
      )}
    </div>
  );
}
