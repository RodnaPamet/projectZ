'use client';

import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { confirmsDeletion } from '@/lib/account/confirm-word';
import { isApiClientError } from '@/lib/data/errors';
import { V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';

import { CreditLossNotice, type ClubCreditView } from './CreditLossNotice';

export type DeleteErrorKey = 'UPCOMING_BOOKINGS' | 'CLUB' | 'RATE_LIMITED' | 'FAILED';

/** A refusal of `DELETE /api/v1/me`, as a catalogue key. */
export function deleteErrorKey(e: unknown): DeleteErrorKey {
  if (!isApiClientError(e)) return 'FAILED';
  if (e.code === 'UPCOMING_BOOKINGS') return 'UPCOMING_BOOKINGS';
  if (e.code === 'CLUB_ACCOUNT_DELETION_BY_REQUEST') return 'CLUB';
  if (e.status === 429) return 'RATE_LIMITED';
  return 'FAILED';
}

/** Where a deleted account lands: the home page, which says so (`?account=deleted`). */
export const DELETED_LANDING = '/?account=deleted';

/**
 * "Да изтрием ли профила ви?" (#370): the typed confirmation.
 *
 * Upstream's pattern for removing a top-level entity, not the vendored
 * `ConfirmDialog`, which has no field and cannot hold its button back: the
 * vendored `Modal` with its header, body and footer, a `FormField` asking for
 * the word, and the destructive `Button` disabled until the word is typed
 * (upstream's TenantsTable and AgentEnforcementCard compose it the same way).
 * The word is ИЗТРИЙ or DELETE in either language, in any case
 * (`confirmsDeletion`): a Bulgarian reader is often on a Latin keyboard.
 *
 * On success every session of the account is already gone, and the response
 * expired this browser's cookie. `signOut` then leaves through next-auth's own
 * sign-out, a full navigation to the home page, so nothing of the page or its
 * cache stays rendered for an account that no longer exists.
 *
 * A refusal keeps the dialog open and says why. `onRefused` lets the page
 * re-read the standing: a booking that appeared since it rendered is listed.
 */
export function DeleteAccountDialog({
  open,
  setOpen,
  credit = [],
  onRefused,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Unused credit lost with the account: said again here, before the word. */
  credit?: ClubCreditView[];
  onRefused?: () => void;
}) {
  const t = useTranslations('profile.delete');
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<DeleteErrorKey | null>(null);
  const [leaving, setLeaving] = useState(false);
  const remove = useV1Mutation<void>({ url: () => V1.deleteAccount(), method: 'DELETE' });

  const busy = remove.isMutating || leaving;
  const confirmed = confirmsDeletion(typed);

  function close() {
    if (busy) return;
    setTyped('');
    setError(null);
    setOpen(false);
  }

  async function confirm() {
    if (!confirmed || busy) return;
    setError(null);
    try {
      await remove.trigger();
    } catch (e) {
      setError(deleteErrorKey(e));
      onRefused?.();
      return;
    }
    setLeaving(true);
    await signOut({ callbackUrl: DELETED_LANDING });
  }

  return (
    <Modal
      showModal={open}
      setShowModal={(next) => {
        if (typeof next === 'function' ? next(open) : next) return;
        close();
      }}
      preventDefaultClose={busy}
    >
      <Modal.Header title={t('dialog.title')} />
      <Modal.Body>
        <form
          className="gap-default flex flex-col"
          data-testid="delete-account-dialog"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <p className="text-content-default text-sm">{t('dialog.body')}</p>
          <CreditLossNotice credit={credit} />
          <FormField label={t('dialog.typeToConfirm', { word: t('dialog.word') })} required>
            <Input
              id={inputId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              autoFocus
              placeholder={t('dialog.word')}
              data-testid="delete-account-confirm-input"
            />
          </FormField>
          {error ? (
            <InlineNotice variant="error" icon={null} data-testid="delete-account-error">
              {t(`error.${error}`)}
            </InlineNotice>
          ) : null}
        </form>
      </Modal.Body>
      <Modal.Footer>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={close}
          text={t('dialog.cancel')}
        />
        <Button
          type="button"
          variant="destructive"
          size="sm"
          loading={busy}
          disabled={busy || !confirmed}
          onClick={() => void confirm()}
          data-testid="delete-account-confirm"
          text={t('dialog.confirm')}
        />
      </Modal.Footer>
    </Modal>
  );
}
