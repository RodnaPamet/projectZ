'use client';

import { signIn } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * ═══ EVERY FAILURE READS THE SAME ═══
 *
 * `authorize()` burns equal bcrypt time on "no such user" and "wrong password"
 * so response TIMING cannot enumerate accounts. That defence is worth nothing
 * if the UI then distinguishes them, so there is exactly one credentials error
 * message here and no branch that could grow a second.
 *
 * The 429 is deliberately a different message, because it describes the
 * REQUEST rather than the account: it is returned on attempt eleven from an IP
 * regardless of whether any address involved exists.
 */
export function LoginForm({ error, callbackUrl }: { error: string | null; callbackUrl: string }) {
  const t = useTranslations('login');
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(
    error ? (error === 'CredentialsSignin' ? t('invalid') : t('unavailable')) : null,
  );

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setFormError(null);

    const data = new FormData(e.currentTarget);

    const res = await signIn('credentials', {
      email: String(data.get('email') ?? ''),
      password: String(data.get('password') ?? ''),
      redirect: false,
      callbackUrl,
    });

    setPending(false);

    if (res?.ok) {
      window.location.assign(callbackUrl);
      return;
    }

    // next-auth surfaces our 429 as a generic failure, so treat an explicitly
    // non-401 status as throttling rather than bad credentials — telling
    // somebody their password is wrong when we never checked it is its own
    // small lie, and it sends them to reset a password that works.
    setFormError(res?.status === 429 ? t('throttled') : t('invalid'));
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="email" className="text-sm font-medium">
            {t('email')}
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="border-input bg-background h-11 w-full rounded-md border px-3 text-base"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="password" className="text-sm font-medium">
            {t('password')}
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="border-input bg-background h-11 w-full rounded-md border px-3 text-base"
          />
        </div>

        {formError ? (
          <p role="alert" className="text-destructive text-sm">
            {formError}
          </p>
        ) : null}

        <Button type="submit" className="w-full" loading={pending} text={t('submit')} />
      </form>

      <div className="flex items-center gap-3">
        <span className="bg-border h-px flex-1" />
        <span className="text-muted-foreground text-xs">{t('or')}</span>
        <span className="bg-border h-px flex-1" />
      </div>

      <Button
        type="button"
        variant="secondary"
        className="w-full"
        onClick={() => signIn('google', { callbackUrl })}
        text={t('withGoogle')}
      />
    </div>
  );
}
