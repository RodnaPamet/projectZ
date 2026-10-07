import { getTranslations } from 'next-intl/server';

import { postSignInPath } from '@/lib/auth/landing';
import { signInMethods } from '@/lib/auth/sign-in-methods';

import { LoginForm } from './login-form';

/** In the visitor's language (#368): this was a Bulgarian literal on the English page too. */
export async function generateMetadata() {
  const t = await getTranslations('login');
  return { title: t('metaTitle') };
}

/**
 * Sign-in.
 *
 * `authOptions.pages` points signIn, signOut AND error here: with only signIn
 * set, next-auth serves its own unbranded ENGLISH pages for the rest, from
 * playerz.bg, to an audience whose default locale is Bulgarian.
 *
 * That routing means this page is also the error surface, so it reads
 * `?error=` and maps it to a message rather than leaving next-auth's raw code
 * (`OAuthSignin`, `AccessDenied`) on screen. One code is explained rather than
 * just mapped: `FacebookEmailRequired`, when Facebook sent no email address
 * (#361) — see the form.
 *
 * ═══ WHICH BUTTONS APPEAR IS DECIDED HERE, NOT IN THE FORM ═══
 *
 * A provider with no credentials is not registered by `src/auth.ts`, so its
 * button would take the user to a next-auth error page for an unknown
 * provider. That decision needs `process.env`, which a client component cannot
 * read — so it is made in this server component and passed down.
 *
 * ═══ WHERE A SIGN-IN ENDS (#227) ═══
 *
 * A deep link wins: `?next=` is what the middleware, the club layout, the
 * invite page and `/me/bookings` all write when they send somebody here, and
 * `?callbackUrl=` is what next-auth writes on a retry. With neither — or with
 * one that is not a path on this site — sign-in ends at `/start`, which lands
 * the person by role. `postSignInPath` is where "safe" is decided.
 *
 * This page used to read `callbackUrl` only, with `/` as the default. Every
 * `?next=` in the app was dropped on the floor, so every deep link through
 * sign-in ended on the home page.
 */
export default async function LoginPage({
  searchParams,
}: {
  // `string[]` is real: a repeated parameter arrives as an array, and an
  // ambiguous destination is treated as none.
  searchParams: Promise<{
    error?: string | string[];
    callbackUrl?: string | string[];
    next?: string | string[];
  }>;
}) {
  const { error, callbackUrl, next } = await searchParams;
  const methods = signInMethods();

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-sm flex-col justify-center px-4">
      <LoginForm
        error={typeof error === 'string' ? error : null}
        // NEXTAUTH_URL is the origin next-auth builds its absolute callback
        // URLs from, so it is the only origin one of them may carry.
        callbackUrl={postSignInPath({ next, callbackUrl }, process.env.NEXTAUTH_URL)}
        google={methods.google === 'configured'}
        facebook={methods.facebook === 'configured'}
      />
    </main>
  );
}
