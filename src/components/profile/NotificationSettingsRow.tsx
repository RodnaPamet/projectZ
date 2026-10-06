'use client';

import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import type { NotificationSettingsDto as NotificationSettings } from '@/app/api/v1/_lib/dto';
import { Button } from '@/components/ui/button';
import { KEYS, V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { useV1SWR } from '@/lib/data/use-v1-swr';

import type { EmailCategory } from './NotificationSettingsSheet';
import { PROFILE_ROW } from './ProfileSection';

const NotificationSettingsSheet = dynamic(() => import('./NotificationSettingsSheet'));

const CATEGORY_COUNT = 3;

/**
 * "Известия" in the profile's Настройки (#367, Q22): which emails to get.
 *
 * The row says how many of the three are on; "Промени" opens the vendored
 * `Sheet` with one vendored `Switch` per category (its own chunk, loaded on
 * the first open). A switch saves at once (`PATCH
 * /api/v1/me/notification-settings`), optimistically: a refusal puts it back
 * and says so. The bell has no switch, and the sheet says why.
 */
export function NotificationSettingsRow({ seed }: { seed: NotificationSettings }) {
  const t = useTranslations('profile.notifications');
  const [open, setOpen] = useState(false);
  // Mounted from the first open on, so it can animate closed.
  const [opened, setOpened] = useState(false);
  const [failed, setFailed] = useState(false);

  const key = KEYS.notificationSettings();
  const { data } = useV1SWR<NotificationSettings>(key, { fallbackData: seed });
  const settings = data ?? seed;

  const save = useV1Mutation<
    Partial<NotificationSettings['email']>,
    NotificationSettings,
    NotificationSettings
  >({
    url: () => V1.updateNotificationSettings(),
    method: 'PATCH',
    body: (email) => ({ email }),
    target: { key },
    update: (current, email) => ({ email: { ...current.email, ...email } }),
    fallback: seed,
  });

  const on = Object.values(settings.email).filter(Boolean).length;

  function toggle(category: EmailCategory, value: boolean) {
    setFailed(false);
    save.trigger({ [category]: value }).catch(() => setFailed(true));
  }

  return (
    <>
      <div className={PROFILE_ROW} data-testid="profile-notifications-row">
        <div className="min-w-0">
          <p className="text-content-default text-sm">{t('row')}</p>
          <p className="text-content-muted text-xs" data-testid="profile-notifications-summary">
            {t('summary', { on, total: CATEGORY_COUNT })}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={() => {
            setOpened(true);
            setOpen(true);
          }}
          aria-label={t('editLabel')}
          data-testid="profile-notifications-edit"
        >
          {t('edit')}
        </Button>
      </div>

      {opened ? (
        <NotificationSettingsSheet
          open={open}
          onOpenChange={setOpen}
          settings={settings}
          onToggle={toggle}
          failed={failed}
        />
      ) : null}
    </>
  );
}
