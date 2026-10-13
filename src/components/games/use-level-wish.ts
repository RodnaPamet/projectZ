'use client';

import { useTranslations } from 'next-intl';
import { useCallback } from 'react';

/**
 * The booker's level wish as words (#376): «Желано ниво 3–4», «Желано ниво
 * 3+», or «Всяко ниво». A wish, never a rule: every asker is answered by the
 * booker, whatever their level.
 */
export function useLevelWish(): (min: number | null, max: number | null) => string {
  const t = useTranslations('games.card');
  return useCallback(
    (min: number | null, max: number | null) => {
      if (min === null && max === null) return t('anyLevel');
      if (min !== null && max !== null) {
        return min === max ? t('levelOne', { level: min }) : t('levelRange', { min, max });
      }
      if (min !== null) return t('levelFrom', { min });
      return t('levelTo', { max: max as number });
    },
    [t],
  );
}
