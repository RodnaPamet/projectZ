'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import type { MeDto } from '@/app/api/v1/_lib/dto';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

import { PROFILE_ROW } from './ProfileSection';
import { useAccount } from './use-account';

/**
 * «Показвай нивото ми» (#576, decision 36), in the profile's Поверителност:
 * whether other players, clubs and coaches see the rating. On by default.
 * Off, results still rate the player and the rating stays on their own page;
 * everyone else sees the level they declared. Saved at once (`PATCH
 * /api/v1/me`), optimistically: a refusal puts the switch back and says so.
 */
export function RatingVisibilityRow({ seed }: { seed: MeDto }) {
  const t = useTranslations('profile.ratingVisibility');
  const id = useId();
  const [failed, setFailed] = useState(false);
  const { account, save } = useAccount(seed);

  return (
    <>
      <div className={PROFILE_ROW} data-testid="profile-rating-visibility">
        <div className="min-w-0">
          <Label htmlFor={id} className="text-content-default cursor-pointer text-sm">
            {t('label')}
          </Label>
          <p className="text-content-muted text-xs">{t('hint')}</p>
        </div>
        <Switch
          id={id}
          checked={account.ratingPublic}
          onCheckedChange={(ratingPublic) => {
            setFailed(false);
            save.trigger({ ratingPublic }).catch(() => setFailed(true));
          }}
          data-testid="profile-rating-visibility-switch"
        />
      </div>
      {failed ? (
        <InlineNotice variant="error" className="mx-4 mb-2">
          {t('failed')}
        </InlineNotice>
      ) : null}
    </>
  );
}
