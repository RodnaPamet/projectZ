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
 * "Показвай ме в търсенето" (#375), in the profile's Поверителност: whether
 * other players find this person by name to write to them. On by default.
 * Off, they are in nobody's search, and only the people they have played with
 * or already talk to can write. Saved at once (`PATCH /api/v1/me`),
 * optimistically: a refusal puts the switch back and says so.
 */
export function SearchVisibilityRow({ seed }: { seed: MeDto }) {
  const t = useTranslations('profile.searchVisibility');
  const id = useId();
  const [failed, setFailed] = useState(false);
  const { account, save } = useAccount(seed);

  return (
    <>
      <div className={PROFILE_ROW} data-testid="profile-search-visibility">
        <div className="min-w-0">
          <Label htmlFor={id} className="text-content-default cursor-pointer text-sm">
            {t('label')}
          </Label>
          <p className="text-content-muted text-xs">{t('hint')}</p>
        </div>
        <Switch
          id={id}
          checked={account.searchable}
          onCheckedChange={(searchable) => {
            setFailed(false);
            save.trigger({ searchable }).catch(() => setFailed(true));
          }}
          data-testid="profile-search-visibility-switch"
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
