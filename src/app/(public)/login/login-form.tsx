'use client';

import { signIn } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
// By module path, not the `icons` barrel: the barrel re-exports every brand
// mark in the directory, and the sign-in page needs two.
import { Facebook } from '@/components/ui/icons/facebook';
import { Google } from '@/components/ui/icons/google';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { FACEBOOK_EMAIL_REQUIRED, FACEBOOK_REREQUEST } from '@/lib/auth/facebook';

type Provider = 'google' | 'facebook';

/**
 * Sign-in, on the web, is Google or Facebook (#361, Q15/Q21).
 *
 * ═══ WHY THERE IS NO EMAIL/PASSWORD FORM ═══
 *
 * Owner's decision: everyone — players, coaches, club staff, admins — signs in
 * with Google or Facebook. Fewer passwords for this app to hold, and account
 * recovery, MFA and revocation are the identity provider's problem rather than
 * ours. Email and password survive for the test suites only, which sign in
 * programmatically and never through this page (`@/lib/auth/password-sign-in`).
 *
 * ═══ WHY A BUTTON CAN BE ABSENT ═══
 *
 * `src/auth.ts` registers a provider only when its credentials are present, so
 * an unconfigured provider has no route to send anyone to. The page decides
 * which buttons exist; this component only renders them.
 *
 * ═══ THE BUTTONS FOLLOW EACH PROVIDER'S OWN RULES ═══
 *
 * Meta's Login button guidelines: the unmodified "f" logo in Facebook blue
 * #1877F2, a white (or, where blue cannot be, black-and-white) button, the
 * call to action inside it, "Log in with Facebook" — "Вход с Facebook". Meta's
 * logo rules put the digital minimum at 16px wide, and the button ladder sizes
 * icons at 15px, so both marks are raised to 16px here. Google's rules ask for
 * its "G" on the same neutral button, so both providers look like what they
 * are and neither is styled as this app's own primary action.
 *
 * ═══ NO EMAIL FROM FACEBOOK ═══
 *
 * `?error=FacebookEmailRequired` is the sign-in callback's refusal when
 * Facebook sent no address (`src/auth.ts`). It is explained in words, and the
 * Facebook button becomes "try again" — which asks Meta to show the declined
 * permission again (`auth_type=rerequest`); without that the dialog does not
 * offer it a second time. Google stays beside it for an account that has no
 * address to give. Every other code gets the one generic message, so a raw
 * next-auth code never reaches the screen.
 */
export function LoginForm({
  error,
  callbackUrl,
  google,
  facebook,
}: {
  error: string | null;
  callbackUrl: string;
  google: boolean;
  facebook: boolean;
}) {
  const t = useTranslations('login');
  const [pending, setPending] = useState<Provider | null>(null);

  // Only while Facebook is still on offer: the explanation ends in "try again".
  const facebookNoEmail = facebook && error === FACEBOOK_EMAIL_REQUIRED;
  const message = error && !facebookNoEmail ? t('unavailable') : null;

  function start(provider: Provider, authorizationParams?: Record<string, string>) {
    setPending(provider);
    void signIn(provider, { callbackUrl }, authorizationParams);
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Heading level={1}>{t('title')}</Heading>
        {/* text-content-muted, not `text-muted-foreground` / `text-destructive`:
            those are shadcn names this theme never defined, so both lines
            rendered in the inherited body colour — an error that looked like
            the subtitle. */}
        <p className="text-content-muted text-sm">{t('subtitle')}</p>
      </div>

      {/* InlineNotice's error variant carries role="alert" itself, so the
          message is still announced the moment it renders. */}
      {message ? <InlineNotice variant="error">{message}</InlineNotice> : null}

      {facebookNoEmail ? (
        <InlineNotice
          variant="error"
          title={t('facebookEmail.title')}
          data-testid="login-facebook-email-required"
        >
          <p>{t('facebookEmail.body')}</p>
          {google ? <p className="mt-1">{t('facebookEmail.googleHint')}</p> : null}
        </InlineNotice>
      ) : null}

      <div className="space-y-3">
        {google ? (
          <Button
            type="button"
            variant="secondary"
            className="w-full [&_svg]:size-4"
            icon={<Google />}
            loading={pending === 'google'}
            disabled={pending !== null}
            onClick={() => start('google')}
            text={t('withGoogle')}
          />
        ) : null}

        {facebook ? (
          <Button
            type="button"
            variant="secondary"
            className="w-full [&_svg]:size-4"
            icon={<Facebook fill="#1877F2" />}
            loading={pending === 'facebook'}
            disabled={pending !== null}
            // The provider id is `facebook`: next-auth builds the redirect URI
            // Meta checks from it, /api/auth/callback/facebook.
            onClick={() =>
              facebookNoEmail ? start('facebook', FACEBOOK_REREQUEST) : start('facebook')
            }
            text={facebookNoEmail ? t('facebookEmail.retry') : t('withFacebook')}
          />
        ) : null}

        {!google && !facebook ? (
          // Better than an empty card. This is a deployment that registered no
          // identity provider, and saying so beats leaving the user to wonder
          // where the buttons went.
          // An error notice (role="alert"), because it is one: nobody can sign
          // in here, and the person reading it has to tell somebody.
          <InlineNotice variant="error">{t('noProviders')}</InlineNotice>
        ) : null}
      </div>
    </div>
  );
}
