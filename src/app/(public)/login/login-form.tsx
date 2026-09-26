'use client';

import { signIn } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

/**
 * Sign-in, on the web, is Google or Microsoft.
 *
 * ═══ WHY THE EMAIL/PASSWORD FORM IS GONE ═══
 *
 * Owner's decision: the web offers federated sign-in only. Fewer passwords for
 * this app to hold, and account recovery, MFA and revocation become the
 * identity provider's problem rather than ours.
 *
 * The credentials PROVIDER is still registered in `src/auth.ts`, deliberately.
 * It is what `POST /api/v1/auth/token` uses, and that is the native client's
 * only way in until the iOS app has an ASWebAuthenticationSession flow (#167).
 * Removing the provider would break the app; removing the FORM does not.
 *
 * So `?error=CredentialsSignin` is still mapped below. Nothing on this page can
 * produce it any more, but the endpoint that can is still live, and a stray
 * code rendered raw is worse than one line of dead mapping.
 *
 * ═══ WHY A BUTTON CAN BE ABSENT ═══
 *
 * `src/auth.ts` registers a provider only when its credentials are present, so
 * an unconfigured provider has no route to send anyone to. The page decides
 * which buttons exist; this component only renders them.
 */
export function LoginForm({
  error,
  callbackUrl,
  google,
  microsoft,
}: {
  error: string | null;
  callbackUrl: string;
  google: boolean;
  microsoft: boolean;
}) {
  const t = useTranslations('login');
  const [pending, setPending] = useState<string | null>(null);

  const message = error ? (error === 'CredentialsSignin' ? t('invalid') : t('unavailable')) : null;

  function start(provider: 'google' | 'azure-ad') {
    setPending(provider);
    void signIn(provider, { callbackUrl });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      {message ? (
        <p role="alert" className="text-destructive text-sm">
          {message}
        </p>
      ) : null}

      <div className="space-y-3">
        {google ? (
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            loading={pending === 'google'}
            disabled={pending !== null}
            onClick={() => start('google')}
            text={t('withGoogle')}
          />
        ) : null}

        {microsoft ? (
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            loading={pending === 'azure-ad'}
            disabled={pending !== null}
            // `azure-ad`, not `microsoft-entra-id`. That is next-auth v4's id
            // for this provider and the callback URL registered in Azure is
            // /api/auth/callback/azure-ad. The v5 name would 404 here.
            onClick={() => start('azure-ad')}
            text={t('withMicrosoft')}
          />
        ) : null}

        {!google && !microsoft ? (
          // Better than an empty card. This is a deployment that registered no
          // identity provider, and saying so beats leaving the user to wonder
          // where the buttons went.
          <p role="alert" className="text-muted-foreground text-sm">
            {t('noProviders')}
          </p>
        ) : null}
      </div>
    </div>
  );
}
