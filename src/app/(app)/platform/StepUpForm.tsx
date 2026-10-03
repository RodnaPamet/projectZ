'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { isApiClientError } from '@/lib/data/errors';
import { V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';

/**
 * "Confirm with a code" — the second-factor step-up every cross-club write
 * asks for (#262).
 *
 * ═══ IT PROVES THE FACTOR, AND DECIDES NOTHING ═══
 *
 * It posts the code to `/api/v1/me/mfa/step-up` and reports success. Whether
 * the session is stepped up, for how long, and for which session, is the
 * server's answer — the platform binding reads it from the session row on
 * every write. A form that "remembered" it here would be a second, weaker
 * copy of a decision that is not this component's to make.
 *
 * Shown by the moderation queue when the API answers STEP_UP_REQUIRED, and by
 * the security page. The caller decides what to retry once it succeeds; the
 * queue re-reads its first page, which is a read the moderator asked for.
 *
 * A recovery code is offered behind a toggle rather than beside the code
 * field: it is the lost-phone path, it is spent by using it, and a second box
 * next to the first invites typing the wrong thing into it.
 */

/** Error codes this form has words for. Anything else reads as UNKNOWN. */
const KNOWN = new Set([
  'MFA_CODE_REJECTED',
  'MFA_ENROLMENT_REQUIRED',
  'RATE_LIMITED',
  'UNAUTHORIZED',
  'NETWORK',
  'VIEWER_CHANGED',
]);

const knownCode = (e: unknown) => (isApiClientError(e) && KNOWN.has(e.code) ? e.code : 'UNKNOWN');

export function StepUpForm({ onStepped }: { onStepped: (expiresAt: string) => void }) {
  const t = useTranslations('platform.stepUp');
  const id = useId();
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const stepUp = useV1Mutation<
    { code?: string; recoveryCode?: string },
    { stepUpExpiresAt: string }
  >({
    url: () => V1.mfaStepUp(),
    body: (arg) => arg,
  });

  const trimmed = value.replace(/\s/g, '');
  const ready = useRecovery ? trimmed.replace(/-/g, '').length === 16 : /^\d{6}$/.test(trimmed);

  async function submit() {
    setError(null);
    try {
      const res = await stepUp.trigger(useRecovery ? { recoveryCode: value } : { code: trimmed });
      setValue('');
      if (res) onStepped(res.stepUpExpiresAt);
    } catch (e) {
      setValue('');
      setError(knownCode(e));
    }
  }

  const fieldId = `${id}-code`;

  return (
    <form
      className="border-border-subtle bg-bg-default grid gap-3 rounded-lg border p-4 sm:max-w-xl"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !stepUp.isMutating) void submit();
      }}
    >
      <div>
        <p className="text-content-emphasis font-medium">{t('title')}</p>
        <p className="text-content-muted mt-1 text-sm">{t('description')}</p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={fieldId}>{useRecovery ? t('recoveryLabel') : t('codeLabel')}</Label>
        <Input
          id={fieldId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          // The OS offers the code from the authenticator / SMS bar on a phone.
          autoComplete={useRecovery ? 'off' : 'one-time-code'}
          inputMode={useRecovery ? 'text' : 'numeric'}
          maxLength={useRecovery ? 24 : 7}
          autoCapitalize={useRecovery ? 'characters' : 'off'}
          spellCheck={false}
        />
      </div>

      {error && (
        <InlineNotice variant="error">
          {t(`error.${error}` as never)}
          {error === 'MFA_ENROLMENT_REQUIRED' && (
            <>
              {' '}
              <Link href="/platform/security" className="underline">
                {t('enrolLink')}
              </Link>
            </>
          )}
        </InlineNotice>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!ready} loading={stepUp.isMutating}>
          {t('submit')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setUseRecovery((r) => !r);
            setValue('');
            setError(null);
          }}
        >
          {useRecovery ? t('useTotp') : t('useRecovery')}
        </Button>
      </div>
    </form>
  );
}
