/**
 * The vendored LocaleSwitcher's view of playerz's locales: playerz-owned, no manifest row.
 *
 * `src/components/layout/LocaleSwitcher.tsx` is copied byte-identical from upstream, which keeps
 * its locales in a module at this path. playerz keeps them in `src/lib/i18n/locales.ts`, the one
 * place the request config and the middleware read. This file re-exports those values under the
 * names the switcher imports, the same way `ui-storage.ts` carries playerz's prefix under
 * upstream's names. A second copy of the cookie name could drift from the one the server reads,
 * and a switcher that wrote `inflect_locale` would change nothing.
 *
 * It renders nowhere yet. The admin shell passes `showLanguage={false}` to the vendored UserMenu
 * (upstream #3100), because the middleware re-seeds `NEXT_LOCALE` from `User.locale` on every
 * signed-in request: a cookie-only switch would flip the page and then flip it straight back.
 * The vendored menu still imports the switcher, so this has to resolve.
 */
import { LOCALES, type Locale } from './i18n/locales';

export {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_LABELS,
  isLocale,
  resolveLocale,
} from './i18n/locales';
export type { Locale };

/** Every locale the UI ships a catalogue for (`messages/<locale>.json`), Bulgarian first. */
export const SUPPORTED_LOCALES = LOCALES;

/** The switcher's visible code. Its accessible name is the endonym in `LOCALE_LABELS`. */
export const LOCALE_SHORT_LABELS: Record<Locale, string> = {
  bg: 'БГ',
  en: 'EN',
};

/** Upstream's name for `isLocale`. */
export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}
