import { readFileSync } from 'node:fs';

/**
 * EVERY THEMED TOKEN HAS A LIGHT VALUE.
 *
 * `src/styles/tokens.css` defines the dark theme (the default) under `:root`
 * and the light theme under `[data-theme='light']`. A token added to `:root`
 * alone still renders in light mode, with the DARK value, so a pale text
 * colour lands on a white page and nobody notices until a person can't read
 * it.
 *
 * tokens.css has said since the port that this guardrail enforces the rule;
 * it didn't exist until #279 found the claim was false.
 *
 * Theme-independent tokens (shape and motion) are the named exceptions: they
 * have one value in both themes, so the light block correctly leaves them out.
 */

const TOKENS = 'src/styles/tokens.css';

const THEME_INDEPENDENT = [/^--radius(-|$)/, /^--duration-/];

/** Every custom property declared in the top-level blocks that `opener` matches. */
function declaredIn(css: string, opener: RegExp): Set<string> {
  const names = new Set<string>();
  for (const m of css.matchAll(opener)) {
    let i = m.index! + m[0].length;
    let depth = 1;
    const start = i;
    while (depth > 0 && i < css.length) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    for (const d of css.slice(start, i).matchAll(/(--[\w-]+)\s*:/g)) names.add(d[1]);
  }
  return names;
}

describe('light-mode parity (src/styles/tokens.css)', () => {
  const css = readFileSync(TOKENS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const dark = declaredIn(css, /^:root\s*\{/gm);
  const light = declaredIn(css, /^\[data-theme=['"]light['"]\]\s*\{/gm);

  it('finds both themes', () => {
    expect(dark.size).toBeGreaterThan(50);
    expect(light.size).toBeGreaterThan(50);
  });

  it('gives every themed dark token a light value', () => {
    const missing = [...dark].filter(
      (t) => !light.has(t) && !THEME_INDEPENDENT.some((re) => re.test(t)),
    );
    expect(missing).toEqual([]);
  });

  it('defines nothing in light that dark lacks', () => {
    expect([...light].filter((t) => !dark.has(t))).toEqual([]);
  });
});
