'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import type { MeDto } from '@/app/api/v1/_lib/dto';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { isApiClientError } from '@/lib/data/errors';
import { MAX_NAME_LENGTH, MIN_NAME_LENGTH } from '@/lib/profile/limits';

import { PROFILE_ROW, ProfileSection } from './ProfileSection';
import { useAccount } from './use-account';

export type NameErrorKey = 'TOO_SHORT' | 'INVALID' | 'FAILED';

/** The server's refusal, or the form's own check, as a catalogue key. */
export function nameErrorKey(e: unknown): NameErrorKey {
  if (!isApiClientError(e)) return 'FAILED';
  const field = (e.details as { field?: unknown } | undefined)?.field;
  if (e.code === 'BAD_REQUEST' && field === 'name') return 'INVALID';
  return 'FAILED';
}

/**
 * "Лични данни" on /me/profile (#359): the display name, and a way to set it.
 *
 * N01: a new account had no name, so the menu said its email twice, and
 * nothing anywhere let the person fix that. The name is what other players
 * see on a booking. The email and the picture are the sign-in provider's
 * (Google, Facebook) and are not edited here; #362's identity header already
 * shows them, so they are not repeated in this section.
 *
 * The name is edited in a sheet (bottom on a phone, side on a desktop), not
 * inline: on a phone an inline field puts the keyboard over the rows below.
 * With no name yet, the section says why it is worth setting.
 *
 * `onNameSaved` runs after the server has stored a new name: the page uses it
 * to refresh the session, whose token carries the name the header shows.
 */
export function PersonalDataSection({
  seed,
  onNameSaved,
}: {
  seed: MeDto;
  onNameSaved?: () => Promise<void> | void;
}) {
  const t = useTranslations('profile.personal');
  const { account, save } = useAccount(seed);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<NameErrorKey | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const inputId = useId();

  function edit() {
    setDraft(account.name ?? '');
    setError(null);
    setOpen(true);
  }

  async function submit() {
    const name = draft.trim().replace(/\s+/g, ' ');
    if (name.length < MIN_NAME_LENGTH) {
      setError('TOO_SHORT');
      return;
    }
    setError(null);
    setSaveFailed(false);
    // Closed at once: the row shows the new name (optimistically) under it.
    setOpen(false);
    try {
      await save.trigger({ name });
      await onNameSaved?.();
    } catch (e) {
      const key = nameErrorKey(e);
      // A refused name goes back into the sheet with the reason, as typed.
      if (key === 'INVALID') {
        setDraft(name);
        setError(key);
        setOpen(true);
      } else {
        setSaveFailed(true);
      }
    }
  }

  return (
    <>
      <ProfileSection title={t('title')} testId="profile-personal">
        <div className={PROFILE_ROW}>
          <div className="min-w-0">
            <p className="text-content-muted text-xs">{t('name')}</p>
            <p
              className={
                account.name
                  ? 'text-content-default truncate text-sm'
                  : 'text-content-muted text-sm italic'
              }
              data-testid="profile-name"
            >
              {account.name ?? t('noName')}
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={edit}
            data-testid="profile-name-edit"
          >
            {account.name ? t('edit') : t('add')}
          </Button>
        </div>
      </ProfileSection>

      {!account.name ? (
        <InlineNotice variant="info" data-testid="profile-name-prompt">
          {t('prompt')}
        </InlineNotice>
      ) : null}
      {saveFailed ? (
        <InlineNotice variant="error" data-testid="profile-name-failed">
          {t('error.FAILED')}
        </InlineNotice>
      ) : null}

      <Sheet open={open} onOpenChange={setOpen} title={t('sheetTitle')} size="sm">
        <Sheet.Header title={t('sheetTitle')} description={t('sheetDescription')} />
        <Sheet.Body>
          <form
            className="gap-compact grid"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <FormField
              label={t('name')}
              description={t('hint', { max: MAX_NAME_LENGTH })}
              error={error ? t(`error.${error}`, { min: MIN_NAME_LENGTH }) : undefined}
            >
              <Input
                id={inputId}
                name="name"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={MAX_NAME_LENGTH}
                autoComplete="name"
                data-testid="profile-name-input"
              />
            </FormField>
            <div className="gap-tight flex">
              <Button type="submit" data-testid="profile-name-save">
                {t('save')}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {t('cancel')}
              </Button>
            </div>
          </form>
        </Sheet.Body>
      </Sheet>
    </>
  );
}
