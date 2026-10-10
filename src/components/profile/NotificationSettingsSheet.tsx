'use client';

import { useTranslations } from 'next-intl';
import { useId } from 'react';

import type { NotificationSettingsDto as NotificationSettings } from '@/app/api/v1/_lib/dto';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Label } from '@/components/ui/label';
import { Sheet } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';

export type EmailCategory = keyof NotificationSettings['email'];
export const EMAIL_CATEGORIES: EmailCategory[] = [
  'confirmation',
  'reminder',
  'clubChanges',
  // #375: a message still unread after about ten minutes.
  'messages',
];

/**
 * The email switches (#367), in the vendored `Sheet`: one vendored `Switch`
 * per category, each labelled, the whole row 44 px tall. Loaded on demand by
 * `NotificationSettingsRow`, so /me/profile's first load carries the row only.
 */
export default function NotificationSettingsSheet({
  open,
  onOpenChange,
  settings,
  onToggle,
  failed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: NotificationSettings;
  onToggle: (category: EmailCategory, value: boolean) => void;
  failed: boolean;
}) {
  const t = useTranslations('profile.notifications');
  const ids = useId();
  const label: Record<EmailCategory, string> = {
    confirmation: t('confirmation'),
    reminder: t('reminder'),
    clubChanges: t('clubChanges'),
    messages: t('messages'),
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('row')} size="sm">
      <Sheet.Header title={t('row')} description={t('sheetDescription')} />
      <Sheet.Body>
        <div className="gap-tight grid">
          {EMAIL_CATEGORIES.map((c) => (
            <div key={c} className="gap-tight flex min-h-11 items-center justify-between">
              <Label htmlFor={`${ids}-${c}`} className="cursor-pointer py-3">
                {label[c]}
              </Label>
              <Switch
                id={`${ids}-${c}`}
                checked={settings.email[c]}
                onCheckedChange={(v) => onToggle(c, v)}
                data-testid={`notifications-email-${c}`}
              />
            </div>
          ))}
          {failed ? (
            <InlineNotice variant="error" data-testid="profile-notifications-failed">
              {t('saveFailed')}
            </InlineNotice>
          ) : null}
        </div>
      </Sheet.Body>
    </Sheet>
  );
}
