/**
 * THE ONE VALUE PLAYERZ CHANGES IN THE VENDORED UI — playerz-owned, no manifest row.
 *
 * The upstream UI routes every persisted UI preference key (theme, view mode, filter
 * presets, recents) through this module so a downstream product changes one
 * constant instead of carrying a diff at every call site. Upstream ships the
 * same file with its own product name as the prefix; playerz's copy differs in
 * that value and in these comments, and in nothing else. The exports, their
 * signatures and their behaviour stay identical to upstream's, because the
 * vendored files that import them (theme-constants, and later the view-mode
 * and column-visibility hooks) are byte-identical copies and must compile
 * against either version.
 *
 * ## The keys changed once, on purpose (T17)
 *
 * Before T17 playerz's copies still spelled upstream's literal keys, so a
 * playerz visitor's theme sat under upstream's name. With the prefix at
 * `'playerz'` they are `playerz_theme` / `playerz:theme`: a saved theme resets
 * to the OS preference once, on the first visit after the deploy. That was
 * accepted in the porting plan, because migrating a single boolean-ish
 * preference is not worth a reader that keeps the old name alive forever.
 * The root layout's SSR read and its pre-paint script take both names from
 * theme-constants, so they follow without an edit.
 *
 * ## Why this file is not vendored
 *
 * It is the seam itself. Vendoring it would put upstream's prefix back, and a
 * `local-diff` row would describe a permanent fork as a pending upstream fix.
 */

/**
 * The namespace every UI preference key carries.
 *
 * Keep it free of `:` and `=` so `uiCookieName` stays a valid RFC 6265 token.
 */
export const UI_STORAGE_PREFIX = 'playerz';

/**
 * A `localStorage` / `sessionStorage` key: the prefix and each part joined by `:`.
 *
 * `uiStorageKey('theme')` → `'playerz:theme'`
 * `uiStorageKey('view-mode', page)` → `'playerz:view-mode:<page>'`
 *
 * Empty and nullish parts are dropped, so a caller threading an optional segment
 * does not produce a key with an empty slot (`'playerz::theme'`) that would read
 * as a different key from the one it meant.
 */
export function uiStorageKey(...parts: Array<string | null | undefined>): string {
  return [UI_STORAGE_PREFIX, ...parts.filter((p): p is string => !!p && p.length > 0)].join(':');
}

/**
 * A cookie name: the prefix and the name joined by `_`.
 *
 * `uiCookieName('theme')` → `'playerz_theme'`
 *
 * Underscore rather than `:` because a cookie name must be an RFC 6265 token and
 * `:` is a separator there.
 */
export function uiCookieName(name: string): string {
  return `${UI_STORAGE_PREFIX}_${name}`;
}
