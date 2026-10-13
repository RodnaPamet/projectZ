'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { isApiClientError } from '@/lib/data/errors';
import { V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';

/** What the step shows for a refusal, by the server's code; anything else is FAILED. */
export const PHONE_STEP_ERRORS = [
  'PHONE_INVALID',
  'PHONE_CODE_WRONG',
  'PHONE_CODE_EXPIRED',
  'PHONE_IN_USE',
  'PHONE_VERIFY_UNAVAILABLE',
  'RATE_LIMITED',
] as const;
export type PhoneStepErrorKey = (typeof PHONE_STEP_ERRORS)[number] | 'FAILED';

export function phoneStepErrorKey(e: unknown): PhoneStepErrorKey {
  if (!isApiClientError(e)) return 'FAILED';
  if (e.status === 429) return 'RATE_LIMITED';
  return (PHONE_STEP_ERRORS as readonly string[]).includes(e.code)
    ? (e.code as PhoneStepErrorKey)
    : 'FAILED';
}

/**
 * The phone step's two screens (#500).
 *
 *   1. the number, as people type it → «Изпрати код»
 *   2. the code from the SMS → «Потвърди», with «Друг номер» and
 *      «Изпрати отново» beside it
 *
 * The number is sent again with the code: the server holds no "pending
 * number" for the account, so what is confirmed is exactly what the person
 * sees on this screen. On success they go on to where they were going.
 */
export function PhoneStep({ to, initialNumber = '' }: { to: string; initialNumber?: string }) {
  const t = useTranslations('phone.step');
  const router = useRouter();
  const ids = useId();
  const [phone, setPhone] = useState(initialNumber);
  const [code, setCode] = useState('');
  /** The number a code went to, hidden in the middle; null on the first screen. */
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<PhoneStepErrorKey | null>(null);

  const start = useV1Mutation<{ phone: string }, { sent: true; number: string }>({
    url: () => V1.startPhone(),
    body: (arg) => arg,
  });
  const confirm = useV1Mutation<{ phone: string; code: string }>({
    url: () => V1.confirmPhone(),
    body: (arg) => arg,
  });

  async function send(again = false) {
    setError(null);
    setResent(false);
    try {
      const res = await start.trigger({ phone });
      setSentTo(res?.number ?? phone);
      setCode('');
      setResent(again);
    } catch (e) {
      setError(phoneStepErrorKey(e));
    }
  }

  async function check() {
    setError(null);
    setResent(false);
    try {
      await confirm.trigger({ phone, code });
      router.replace(to);
      router.refresh();
    } catch (e) {
      setError(phoneStepErrorKey(e));
    }
  }

  const notice = error ? (
    <InlineNotice variant="error" data-testid="phone-error">
      {t(`error.${error}`)}
    </InlineNotice>
  ) : null;

  if (sentTo === null) {
    return (
      <form
        className="gap-section flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (phone.trim() && !start.isMutating) void send();
        }}
        data-testid="phone-step-number"
      >
        <FormField label={t('number.label')} description={t('number.hint')}>
          <Input
            id={`${ids}-phone`}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder={t('number.placeholder')}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            data-testid="phone-input"
          />
        </FormField>
        {notice}
        <Button
          type="submit"
          disabled={!phone.trim()}
          loading={start.isMutating}
          data-testid="phone-send"
        >
          {t('number.submit')}
        </Button>
      </form>
    );
  }

  return (
    <form
      className="gap-section flex flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim() && !confirm.isMutating) void check();
      }}
      data-testid="phone-step-code"
    >
      <p className="text-content-default text-sm" data-testid="phone-sent-to">
        {t('code.sentTo', { number: sentTo })}
      </p>
      <FormField label={t('code.label')}>
        <Input
          id={`${ids}-code`}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          data-testid="phone-code-input"
        />
      </FormField>
      {resent && !error ? (
        <InlineNotice variant="success" data-testid="phone-resent">
          {t('code.resent')}
        </InlineNotice>
      ) : null}
      {notice}
      <Button
        type="submit"
        disabled={!code.trim()}
        loading={confirm.isMutating}
        data-testid="phone-confirm"
      >
        {t('code.submit')}
      </Button>
      <div className="gap-tight flex flex-wrap">
        <Button
          type="button"
          variant="ghost"
          onClick={() => void send(true)}
          loading={start.isMutating}
          data-testid="phone-resend"
        >
          {t('code.resend')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setSentTo(null);
            setCode('');
            setError(null);
            setResent(false);
          }}
          data-testid="phone-change"
        >
          {t('code.change')}
        </Button>
      </div>
    </form>
  );
}
