/**
 * The locale contract — SERVER-SAFE, and the only source of truth.
 *
 * ═══ WHY THIS FILE REPLACED TWO OTHERS ═══
 *
 * There were two, and they disagreed:
 *
 *   src/lib/i18n/request.ts  — LOCALES ['bg','en'], DEFAULT 'bg', and it
 *                              hardcoded the locale, reading no cookie and no
 *                              user preference.
 *   src/lib/locale-constants.ts — SUPPORTED ['en','bg'], DEFAULT 'en', cookie
 *                              `inflect_locale`, with a docblock claiming the
 *                              next-intl request config read it.
 *
 * Nothing imported the second one. It was ported scaffolding describing a
 * mechanism that did not exist, while the live config hardcoded the opposite
 * default — so the UI was Bulgarian by accident, `User.locale` drove nothing,
 * and English was unreachable however the user asked for it.
 *
 * ═══ BULGARIAN IS THE DEFAULT, INCLUDING BEFORE SIGN-IN ═══
 *
 * playerz.bg is a Bulgarian product. A first-time visitor who has never
 * signed in sees Bulgarian, which means the fallback here — not just the
 * authenticated path — has to be `bg`.
 *
 * This is deliberately NOT how agri-saas does it. There the fallback is `en`
 * and Bulgarian arrives through the authenticated user's stored preference,
 * to keep pre-login pages in English for its E2E specs. That trade-off is
 * specific to that product; here the pre-login page is the shop window.
 *
 * MUST NOT carry `'use client'` and MUST NOT import a client-only module: it
 * is read by the next-intl request config, by middleware, and by the root
 * layout's `<html lang>`.
 */

/** Every locale the UI ships a message catalogue for (`messages/<locale>.json`). */
export const LOCALES = ['bg', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * What an unrecognised, absent or pre-sign-in locale resolves to.
 *
 * Bulgarian. `User.locale` carries the same default at the database level, so
 * the two agree for an authenticated user and there is no moment where the
 * page changes language under someone after they sign in.
 */
export const DEFAULT_LOCALE: Locale = 'bg';

/**
 * The cookie the server reads to resolve the request locale.
 *
 * `NEXT_LOCALE` is the next-intl / Next.js convention, and what agri-saas
 * uses. The dead module named it `inflect_locale`, which was neither this
 * product's name nor a convention anything honoured.
 */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

/**
 * Labels for the language switcher, as ENDONYMS — each language names itself
 * in its own script, so the option is recognisable whichever locale is
 * currently active. Deliberately not translated through the catalogue.
 */
export const LOCALE_LABELS: Record<Locale, string> = {
  bg: 'Български',
  en: 'English',
};

/** Narrow an untrusted value — a cookie, a JWT claim, a database column. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Coerce anything to a supported locale, falling back to Bulgarian. */
export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
