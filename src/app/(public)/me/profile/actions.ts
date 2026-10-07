'use server';

import { setMyLocale } from '@/app-layer/usecases/my-locale';
import { requireSignedIn } from '@/lib/auth/page-context';
import { isLocale } from '@/lib/i18n/locales';

/**
 * Save the caller's UI language (#362). The profile page's switch calls this
 * before it writes the cookie; see `setMyLocale` for the order and why.
 *
 * No club permission applies: the row is the caller's own user, found by the
 * signed-in session, never by an id from the request
 * (`server-actions-authorise` lists this file and says so). A locale outside
 * the catalogue is refused, not coerced, so a tampered call cannot store one.
 */
export async function saveMyLocaleAction(locale: string): Promise<{ ok: boolean }> {
  const userId = await requireSignedIn();
  if (!userId) return { ok: false };
  if (!isLocale(locale)) return { ok: false };

  await setMyLocale(userId, locale);
  return { ok: true };
}
