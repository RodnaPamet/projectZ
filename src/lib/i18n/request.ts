import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, type Locale } from './locales';

/**
 * Resolve the active UI locale, once per request.
 *
 * This used to be `const locale = DEFAULT_LOCALE;` — a constant. Bulgarian was
 * correct by accident, but nothing a user did could change it: not the
 * `User.locale` column (which has existed, defaulting to `bg`, and driven
 * nothing), not a cookie, not a header.
 *
 * The cookie is the only channel read here, and it is validated rather than
 * trusted — a cookie is user-controlled, and `messages/${locale}.json` is a
 * dynamic import. `isLocale` narrowing it to the two shipped catalogues is
 * what stops that being a path traversal.
 *
 * Middleware seeds the cookie from the signed-in user's stored preference, so
 * the FIRST server-rendered byte is already in their language — no client
 * round-trip and no flash of the wrong one.
 */
export default getRequestConfig(async () => {
  let locale: Locale = DEFAULT_LOCALE;

  try {
    const value = (await cookies()).get(LOCALE_COOKIE)?.value;
    if (isLocale(value)) locale = value;
  } catch {
    // No request cookie store — a static render. Keep the default.
  }

  return {
    locale,
    messages: (await import(`../../../messages/${locale}.json`)).default,
  };
});
