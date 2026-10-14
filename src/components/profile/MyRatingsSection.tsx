'use client';

import { useFormatter, useTranslations } from 'next-intl';

import { Caption } from '@/components/ui/typography';
import { KEYS } from '@/lib/data/keys';
import { useV1SWR } from '@/lib/data/use-v1-swr';

import { PROFILE_ROW, ProfileSection } from './ProfileSection';
import { useLevelLabel } from './use-level-label';

/** `GET /api/v1/me/ratings` (#576). */
export interface MyRatingsDto {
  public: boolean;
  items: Array<{
    sport: string;
    level: number;
    provisional: boolean;
    points: number | null;
    matchesPlayed: number;
    lastPlayedAt: string | null;
  }>;
}

/**
 * «Класиране» on the player's own page (#576): each sport's level as others
 * see it, and what only the player sees (decision 31): the engine's points
 * and the confirmed matches behind them. Shown while the ranking module is on.
 */
export function MyRatingsSection({ seed }: { seed: MyRatingsDto }) {
  const t = useTranslations('profile.ratings');
  const tSports = useTranslations('sports');
  const format = useFormatter();
  const levelLabel = useLevelLabel();
  const { data } = useV1SWR<MyRatingsDto>(KEYS.myRatings(), { fallbackData: seed });
  const view = data ?? seed;

  return (
    <ProfileSection title={t('title')} testId="profile-ratings">
      {view.items.length === 0 ? (
        <div className={PROFILE_ROW}>
          <span className="text-content-muted text-sm">{t('none')}</span>
        </div>
      ) : (
        view.items.map((r) => (
          <div key={r.sport} className={PROFILE_ROW} data-testid={`profile-rating-${r.sport}`}>
            <span className="text-content-default text-sm font-medium">
              {tSports(r.sport as never)}
            </span>
            <span className="min-w-0 text-right">
              <span className="text-content-default block text-sm">
                {levelLabel({
                  level: r.level,
                  rating: { level: r.level, provisional: r.provisional },
                })}
              </span>
              <Caption className="block">
                {r.points === null
                  ? t('noMatches')
                  : t('points', {
                      points: format.number(r.points, { maximumFractionDigits: 1 }),
                      count: r.matchesPlayed,
                    })}
              </Caption>
            </span>
          </div>
        ))
      )}
      <div className="px-4 py-2">
        <Caption>{view.public ? t('hint') : t('hintHidden')}</Caption>
      </div>
    </ProfileSection>
  );
}
