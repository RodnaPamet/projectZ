'use client';

import { useFormatter, useTranslations } from 'next-intl';

/** A sport on a player's card: the level they declared, and their rating if it shows (#576). */
export interface LevelOnCard {
  level: number;
  rating?: { level: number; provisional: boolean } | null;
}

/**
 * «Ниво 4», as the player declared it; or, once ranking shows their rating,
 * «Ниво 4,3», and «Ниво 4,3 (неокончателно)» while it is provisional
 * (decision 47).
 */
export function useLevelLabel(): (s: LevelOnCard) => string {
  const t = useTranslations('profile.sports');
  const format = useFormatter();
  return (s) => {
    if (!s.rating) return t('levelShort', { level: s.level });
    const level = format.number(s.rating.level, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    return s.rating.provisional ? t('ratedProvisional', { level }) : t('rated', { level });
  };
}
