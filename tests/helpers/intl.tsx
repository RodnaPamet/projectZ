import { NextIntlClientProvider } from 'next-intl';

import bg from '../../messages/bg.json';
import en from '../../messages/en.json';

/**
 * Wrap a rendered component in the REAL catalogue: Bulgarian, or English when asked.
 *
 * Primitives that call `useTranslations()` throw outside a provider, so a test
 * rendering one has to supply it. Using the real `messages/bg.json` rather than
 * a handful of inline strings means the test exercises the copy a user
 * actually sees, and a key that disappears from the catalogue shows up here as
 * the bare key name instead of passing quietly.
 *
 * A test that cares about ONE specific string can still pass its own messages
 * — see mobile-affordances.test.tsx, which does exactly that and should keep
 * doing it: asserting on a stable fixture beats asserting on product copy
 * somebody may reword.
 */
export function withIntl(ui: React.ReactNode, locale: 'bg' | 'en' = 'bg') {
  // The catalogue follows the locale. It was always `bg`, so a test asking for
  // English silently rendered Bulgarian and asserted nothing about English.
  return (
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : bg}>
      {ui}
    </NextIntlClientProvider>
  );
}

/** The real Bulgarian catalogue, for asserting on copy without hardcoding it. */
export { bg as messages };

/** The real English catalogue, for the same, under `withIntl(ui, 'en')`. */
export { en as enMessages };
