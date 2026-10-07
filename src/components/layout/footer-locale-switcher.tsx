'use client';

import { LocaleSwitcher } from '@/components/layout/LocaleSwitcher';

/**
 * The public footer's language switch (#368): the vendored `LocaleSwitcher`.
 *
 * Signed out, the cookie IS the preference, and the switcher writes it on its
 * own. Signed in, the preference lives on the user (#362) and the middleware
 * re-seeds the cookie from it on every request, so the switch must write the
 * record first (`persistMyLocale`), exactly as the profile page's does.
 *
 * That module (the server action and next-auth's client) is imported only when
 * a signed-in person actually switches: an anonymous visitor's page never
 * downloads it.
 */
export function FooterLocaleSwitcher({ signedIn }: { signedIn: boolean }) {
  return (
    <LocaleSwitcher
      onLocaleChange={
        signedIn
          ? async (locale) => {
              const { persistMyLocale } = await import('@/lib/i18n/persist-my-locale');
              await persistMyLocale(locale);
            }
          : undefined
      }
    />
  );
}
