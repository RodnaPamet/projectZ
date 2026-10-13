'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { PHONE_LATER_COOKIE, PHONE_LATER_MAX_AGE } from '@/lib/auth/phone-ask';
import { refreshSession } from '@/lib/auth/refresh-session';
import { isApiClientError } from '@/lib/data/errors';
import { V1 } from '@/lib/data/keys';
import { useV1Mutation } from '@/lib/data/use-v1-mutation';
import { loadPage } from '@/lib/navigation/load-page';

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
 * The number is sent again with the code, and with the `challenge` the send
 * answered: the server holds no "pending number" for the account, and the
 * challenge is what ties this code to this account and this number. On
 * success the session is refreshed (its token carries "a number is
 * confirmed", for the one-time ask) and the destination is LOADED, as the
 * terms step does and for its reason.
 */
export function PhoneStep({ to, initialNumber = '' }: { to: string; initialNumber?: string }) {
  const t = useTranslations('phone.step');
  const ids = useId();
  const [phone, setPhone] = useState(initialNumber);
  const [code, setCode] = useState('');
  /** The number a code went to, hidden in the middle; null on the first screen. */
  const [sentTo, setSentTo] = useState<string | null>(null);
  /** What the send answered with; the confirm sends it back with the code. */
  const [challenge, setChallenge] = useState('');
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<PhoneStepErrorKey | null>(null);
  const [leaving, setLeaving] = useState(false);

  const start = useV1Mutation<{ phone: string }, { sent: true; number: string; challenge: string }>(
    {
      url: () => V1.startPhone(),
      body: (arg) => arg,
    },
  );
  const confirm = useV1Mutation<{ phone: string; code: string; challenge: string }>({
    url: () => V1.confirmPhone(),
    body: (arg) => arg,
  });

  async function send(again = false) {
    setError(null);
    setResent(false);
    try {
      const res = await start.trigger({ phone });
      setSentTo(res?.number ?? phone);
      setChallenge(res?.challenge ?? '');
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
      await confirm.trigger({ phone, code, challenge });
      setLeaving(true);
      // The session token says "still to ask" until next-auth re-reads the
      // account; with the old one the next page would come straight back here.
      // A refresh that fails is not a reason to stay: the page puts it right.
      await refreshSession().catch(() => undefined);
      loadPage(to);
    } catch (e) {
      setLeaving(false);
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
        loading={confirm.isMutating || leaving}
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

/**
 * «Не сега»: remember, in this browser, that the person was asked, and go on
 * (#500; owner decision 2026-10-13: the step can be skipped). The cookie only
 * stops the ask. Booking, joining a game and writing a message still need a
 * number, and offer this step themselves.
 */
export function PhoneLater({ to }: { to: string }) {
  const t = useTranslations('phone.step');
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => {
        const secure = window.location.protocol === 'https:' ? '; secure' : '';
        document.cookie = `${PHONE_LATER_COOKIE}=1; path=/; max-age=${PHONE_LATER_MAX_AGE}; samesite=lax${secure}`;
        loadPage(to);
      }}
      data-testid="phone-later"
    >
      {t('later')}
    </Button>
  );
}

/**
 * Nothing to ask after all: the account has a number, or is not one the rule
 * is for, and the session token did not know. Refresh it and go on, unasked;
 * if the refresh fails, offer to try again rather than loop.
 */
export function PhoneStepDone({ to }: { to: string }) {
  const t = useTranslations('phone.step');
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  const go = () =>
    refreshSession()
      .then(() => loadPage(to))
      .catch(() => setFailed(true));

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void go();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  if (!failed) {
    return (
      <p className="text-content-muted text-sm" role="status" data-testid="phone-continuing">
        {t('continuing')}
      </p>
    );
  }
  return (
    <div className="gap-compact flex flex-col">
      <InlineNotice variant="error" data-testid="phone-error">
        {t('error.FAILED')}
      </InlineNotice>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setFailed(false);
          void go();
        }}
        data-testid="phone-retry"
      >
        {t('retry')}
      </Button>
    </div>
  );
}
