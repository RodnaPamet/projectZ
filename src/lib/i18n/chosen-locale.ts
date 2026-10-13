import { cookies } from 'next/headers';

import { LOCALE_COOKIE, isLocale, type Locale } from './locales';

/**
 * The language this request's visitor chose with the switcher (the
 * `NEXT_LOCALE` cookie), or undefined: nothing chosen, a value that is not one
 * of ours, or no request at all (a script, a static render).
 *
 * For the one moment a signed-out choice has to become a person's: a new
 * account starts in it (#431). Everything after reads `User.locale`.
 */
export async function chosenLocale(): Promise<Locale | undefined> {
  try {
    const value = (await cookies()).get(LOCALE_COOKIE)?.value;
    return isLocale(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
