'use client';

import { useTranslations } from 'next-intl';

import type { PlayerCardDto as PlayerCard } from '@/app/api/v1/_lib/messaging';
import { Card } from '@/components/ui/card';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { StatusBadge } from '@/components/ui/status-badge';
import { Caption, Heading } from '@/components/ui/typography';

import { StartConversationButton } from './StartConversationButton';

/**
 * A player's public card (#375): the name, the picture, and the sports they
 * play with the level they gave each — and nothing else. Never an email, a
 * phone or a booking: the API does not send them, and this has no place for
 * them. "Пиши" opens the conversation.
 */
export function PlayerCardView({ card }: { card: PlayerCard }) {
  const t = useTranslations('messaging.card');
  const tSports = useTranslations('sports');
  const tLevel = useTranslations('profile.sports');
  const name = card.name ?? t('unnamed');

  return (
    <Card elevation="flat" className="gap-default flex flex-col" data-testid="player-card">
      <div className="flex items-center gap-3">
        <InitialsAvatar value={name} imageUrl={card.avatarUrl} size="lg" />
        <Heading level={2} className="min-w-0 truncate text-lg">
          {name}
        </Heading>
      </div>
      {card.sports.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={t('sports')}>
          {card.sports.map((s) => (
            <li key={s.sport}>
              <StatusBadge variant="neutral" icon={null}>
                {tSports(s.sport as never)} · {tLevel('levelShort', { level: s.level })}
              </StatusBadge>
            </li>
          ))}
        </ul>
      ) : (
        <Caption>{t('noSports')}</Caption>
      )}
      <StartConversationButton
        to={{ playerId: card.userId }}
        variant="primary"
        className="self-start"
        testId="player-card-write"
      />
    </Card>
  );
}
