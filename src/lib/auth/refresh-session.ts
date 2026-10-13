import { getCsrfToken } from 'next-auth/react';

/**
 * Have next-auth re-read the signed-in account into its session token.
 *
 * next-auth's CSRF-checked session update (`POST /api/auth/session`), which
 * `auth.ts` answers as `trigger: 'update'`: it reads the language, the display
 * name (#359) and the accepted terms versions (#462) from the user's own row
 * in the database, never from this request, which carries no values.
 *
 * Called after something the token mirrors has changed, so the middleware and
 * the header stop acting on the old value: the language switch
 * (persist-my-locale.ts), the first-sign-in choice and the terms step.
 *
 * A module of its own, with no import but next-auth's client: the screens that
 * call it are client components, and must not pull a server action's module
 * (and with it the database client) into their bundle or their tests.
 *
 * Throws when the update is refused.
 */
export async function refreshSession(): Promise<void> {
  const csrfToken = await getCsrfToken();
  const res = await fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ csrfToken, data: {} }),
  });
  if (!res.ok) throw new Error('session not refreshed');
}
