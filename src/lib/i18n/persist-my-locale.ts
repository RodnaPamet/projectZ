import { getCsrfToken } from 'next-auth/react';

import { saveMyLocaleAction } from '@/app/(app)/me/profile/actions';

/**
 * Save a SIGNED-IN person's language (#362, #368), for the vendored
 * `LocaleSwitcher`'s `onLocaleChange` (upstream #3185). The profile page and
 * the public footer both use it.
 *
 * Write the language to the user record, then have next-auth re-read it into
 * the token, BEFORE the switcher sets the cookie. The middleware re-seeds the
 * cookie from the token on every request, so with the old token in place the
 * new language would be flipped straight back. `auth.ts` reads the value from
 * the database on `trigger: 'update'`; this request carries none.
 *
 * A signed-out visitor needs none of this: the cookie IS their preference, and
 * the switcher writes it on its own.
 *
 * Throws when either step fails, which the switcher reads as "abandon the
 * switch": no cookie, no refresh, the old language stays selected.
 */
export async function persistMyLocale(locale: string): Promise<void> {
  const saved = await saveMyLocaleAction(locale);
  if (!saved.ok) throw new Error('locale not saved');
  await refreshSession();
}

/**
 * next-auth's CSRF-checked session update: `auth.ts` re-reads the locale and
 * the display name (#359) from the user's own row into the token.
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
