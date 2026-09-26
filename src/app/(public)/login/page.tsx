import { signInMethods } from '@/lib/auth/sign-in-methods';

import { LoginForm } from './login-form';

export const metadata = { title: 'Вход — playerz.bg' };

/**
 * Sign-in.
 *
 * `authOptions.pages` points signIn, signOut AND error here: with only signIn
 * set, next-auth serves its own unbranded ENGLISH pages for the rest, from
 * playerz.bg, to an audience whose default locale is Bulgarian.
 *
 * That routing means this page is also the error surface, so it reads
 * `?error=` and maps it to a message rather than leaving next-auth's raw code
 * (`CredentialsSignin`, `OAuthSignin`) on screen.
 *
 * ═══ WHICH BUTTONS APPEAR IS DECIDED HERE, NOT IN THE FORM ═══
 *
 * A provider with no credentials is not registered by `src/auth.ts`, so its
 * button would take the user to a next-auth error page for an unknown
 * provider. That decision needs `process.env`, which a client component cannot
 * read — so it is made in this server component and passed down.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const { error, callbackUrl } = await searchParams;
  const methods = signInMethods();

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-sm flex-col justify-center px-4">
      <LoginForm
        error={error ?? null}
        callbackUrl={callbackUrl ?? '/'}
        google={methods.google === 'configured'}
        microsoft={methods.microsoft === 'configured'}
      />
    </main>
  );
}
