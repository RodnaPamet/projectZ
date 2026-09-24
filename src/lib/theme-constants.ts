/**
 * Theme constants — SERVER-SAFE.
 *
 * This module MUST NOT carry a `'use client'` directive and MUST NOT import any
 * client-only module, so that a SERVER component can read the literal values.
 *
 * NOT YET WIRED (found while diagnosing issue #115): nothing on the server
 * reads them today. `src/app/layout.tsx` renders `<html>` with no `data-theme`
 * and no anti-FOUC inline script, so SSR always ships the dark `:root` palette
 * and `ThemeProvider`'s mount effect flips it AFTER first paint. A
 * light-preferring visitor therefore still sees a dark→light flash on first
 * load, and anything sampling colour just after `load` can catch the 150ms
 * button transition mid-flight — which is exactly what made the design-system
 * axe check fail on an unchanged tree.
 *
 * Why this file exists (load-bearing): these constants previously lived in
 * `ThemeProvider.tsx`, which is a `'use client'` module. When a server
 * component imports a value from a `'use client'` module, Next replaces the
 * export with a CLIENT REFERENCE PROXY — so on the server `THEME_COOKIE` was a
 * function, not the string `'inflect_theme'`. That silently broke BOTH
 * `cookies().get(THEME_COOKIE)` (always undefined → SSR fell back to `dark`)
 * AND `JSON.stringify(THEME_STORAGE_KEY)` in the inline script (→ `undefined`
 * localStorage key) — which is why the theme flashed on every reload.
 *
 * Keep the literal values HERE; the client `ThemeProvider` re-exports them.
 */

export type Theme = 'dark' | 'light';

/** localStorage key (legacy/back-compat mirror, client-only). */
export const THEME_STORAGE_KEY = 'inflect:theme';

/**
 * Cookie name — the flash-proof, server-readable channel. RFC6265 token (no
 * `:`), so it differs from THEME_STORAGE_KEY.
 */
export const THEME_COOKIE = 'inflect_theme';
