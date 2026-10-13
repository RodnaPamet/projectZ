import { globSync, readFileSync } from 'node:fs';

/**
 * `safe-area-x` AND SIDE PADDING NEVER SHARE AN ELEMENT (#288, #295).
 *
 * `.safe-area-x` (src/app/globals.css) sets `padding-left/right` to the notch
 * insets. It sits outside any cascade layer, so it beats Tailwind v4's layered
 * utilities: on an element that also carries `px-6` (or `p-6`, `pl-4`, …) the
 * gutter is replaced, not added to. On a phone with no notch the inset is 0,
 * and the content sits flush against the screen edge. /platform/moderation,
 * the invite pages and the app's error page all shipped like that.
 *
 * The fix is structural: insets on an outer element, the gutter on an inner
 * one. This keeps it that way.
 */

const SIDE_PADDING = /^(?:[a-z0-9-]+:)*(?:p|px|pl|pr|ps|pe)-/;

describe('safe-area-x is never combined with side padding on one element', () => {
  const offenders: string[] = [];

  for (const file of globSync('src/**/*.tsx')) {
    const src = readFileSync(file, 'utf8');
    // Every quoted or template string that names the utility: a className, a
    // cn() argument, a variant map value.
    for (const m of src.matchAll(/(["'`])((?:(?!\1)[^\n])*\bsafe-area-x\b(?:(?!\1)[^\n])*)\1/g)) {
      const classes = m[2].split(/\s+/);
      const padding = classes.filter((c) => SIDE_PADDING.test(c));
      if (padding.length > 0) offenders.push(`${file}: ${padding.join(' ')}`);
    }
  }

  it('finds none', () => {
    expect(offenders).toEqual([]);
  });
});
