import { readFileSync } from 'node:fs';
import path from 'node:path';

import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';

/**
 * THE GENERATED CSS OPTIMIZES WITHOUT A SINGLE WARNING.
 *
 * ═══ WHY ═══
 *
 * Tailwind v4 scans every file in the repo, docs and comments included, and
 * turns anything class-shaped into a rule. A doc that abbreviated a class as
 * `text-` + `[var(--brand-` + `*)]` (split here on purpose) compiled to
 *
 *     .text-\[var\(--brand-\*\)\] { color: var(--brand-*); }
 *
 * which is not valid CSS (#284). The two build paths disagree about it:
 *
 *   next build   lightningcss drops the rule and prints "Found 1 warning while
 *                optimizing generated CSS". CI stays green.
 *   next dev     Next's CSS parser rejects globals.css, so EVERY page returns
 *                500 (measured in #248).
 *
 * A warning that only shows up in a green log is invisible, so this makes it
 * red. It builds src/app/globals.css through the same PostCSS plugin the app
 * uses, with optimization forced on, and fails on any warning the optimizer
 * prints. That covers every class-shaped string in every scanned file, not just
 * the `*` one: `<name>` inside the brackets fails the same way.
 *
 * ═══ FIXING A FAILURE ═══
 *
 * The message quotes the offending rule. `git grep -F` the class, then reword
 * the mention so it is not class-shaped (describe it in words, or split it
 * across two code spans). Do not add a `@source not` for docs/: the next copy
 * will be in a comment under src/.
 *
 * Takes ~200ms: Tailwind's scanner is native.
 */

const ROOT = path.resolve(__dirname, '../..');
const GLOBALS = path.join(ROOT, 'src/app/globals.css');

/** The optimizer's warning header, printed by @tailwindcss/node via console.warn. */
const OPTIMIZER_WARNING = /Found \d+ warnings? while optimizing generated CSS/;

async function optimizerWarnings(css: string, from: string): Promise<string[]> {
  const warnings: string[] = [];
  const spy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
  try {
    await postcss([tailwind({ optimize: { minify: false } })]).process(css, { from });
  } finally {
    spy.mockRestore();
  }
  // Strip ANSI styling so the failure message reads cleanly.
  return warnings.filter((w) => OPTIMIZER_WARNING.test(w)).map((w) => w.replace(/\x1b\[\d+m/g, ''));
}

describe('generated Tailwind CSS optimizes clean', () => {
  it('app/globals.css produces no optimizer warnings', async () => {
    const warnings = await optimizerWarnings(readFileSync(GLOBALS, 'utf8'), GLOBALS);
    expect(warnings).toEqual([]);
  }, 60_000);

  it('negative control: a class-shaped `*` inside brackets is caught', async () => {
    // source(none) keeps the repo out of this build, and the inline source
    // feeds exactly the #284 candidate, assembled so this file never contains it.
    const candidate = 'text-[var(--brand-' + '*)]';
    const css = `@import 'tailwindcss' source(none);\n@source inline("${candidate}");\n`;
    const warnings = await optimizerWarnings(css, path.join(__dirname, 'negative-control.css'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Unexpected token Delim('*')");
  }, 60_000);
});
