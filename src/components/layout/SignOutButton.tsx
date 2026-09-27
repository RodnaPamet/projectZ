'use client';

import { signOut } from 'next-auth/react';
import { useTranslations } from 'next-intl';

/**
 * Sign out.
 *
 * A client component for one reason: `signOut()` must POST to
 * /api/auth/signout with a CSRF token, and next-auth's helper fetches that
 * token itself. A plain <a href="/api/auth/signout"> would GET, which
 * next-auth answers with its own unbranded English confirmation page — and a
 * GET sign-out is a one-pixel-image logout CSRF anyway.
 *
 * It needs no SessionProvider. `signOut` reads /api/auth/csrf over fetch
 * rather than from context, so wrapping the tree would buy nothing here.
 */
export function SignOutButton() {
  const t = useTranslations('common');

  return (
    <button
      type="button"
      // Back to the homepage rather than to /login. Signing out and landing on
      // a sign-in form reads as "that failed, try again".
      onClick={() => void signOut({ callbackUrl: '/' })}
      className="text-content-muted hover:text-content-default text-sm underline-offset-4 hover:underline"
    >
      {t('signOut')}
    </button>
  );
}
