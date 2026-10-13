import { saveMyLocaleAction } from '@/app/(public)/me/profile/actions';
import { refreshSession } from '@/lib/auth/refresh-session';

/**
 * Save a SIGNED-IN person's language (#362, #368), for the vendored
 * `LocaleSwitcher`'s `onLocaleChange` (upstream #3185). A signed-in account
 * switches its language in two places, and both hand it this: the profile
 * page, and the account menu's Език row in every shell (`UserMenu`'s
 * `onLocaleChange`, upstream #3248).
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

// `refreshSession` lives in src/lib/auth/refresh-session.ts; re-exported for
// the callers that already took it from here.
export { refreshSession };
