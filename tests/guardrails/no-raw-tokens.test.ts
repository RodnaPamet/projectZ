import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * P02 guardrail — semantic tokens only.
 *
 * The whole point of the token system is that a rebrand touches
 * `src/styles/tokens.css` and nothing else. A raw Tailwind colour scale
 * (`bg-slate-800`, `text-gray-500`) hard-codes a hue into a component and
 * silently opts that component out of theming — it will look correct in
 * one theme and wrong in the other.
 *
 * This is a RATCHET: the allowlist may only ever shrink. Adding an entry
 * requires justifying, in writing, why the component cannot use a
 * semantic token.
 */

/**
 * `brand` is absent on purpose. It is this product's own palette, and its shades
 * are fine as FILLS (`bg-brand-600`). As TEXT they are not: no brand shade is
 * body text in both themes, so no-raw-brand-text.test.ts bans `text-brand-NNN`
 * in favour of `text-content-brand` (#233).
 */
const RAW_COLOR_SCALES =
  /\b(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|shadow|accent|caret|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|\d{3})\b/g;

/**
 * Curated exceptions. P02 caps this at 3 entries at port time.
 * RATCHET-ONLY: this list may shrink, never grow.
 */
const ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [];

function sourceFiles(): string[] {
  const roots = ['src/app', 'src/components'];
  const out: string[] = [];
  for (const root of roots) {
    out.push(...globSync(`${root}/**/*.{ts,tsx}`, { cwd: process.cwd() }).map((f) => f.toString()));
  }
  return out;
}

describe('no raw Tailwind colour scales in app/ or components/', () => {
  const offenders: Array<{ file: string; line: number; token: string }> = [];

  beforeAll(() => {
    for (const file of sourceFiles()) {
      const text = readFileSync(join(process.cwd(), file), 'utf8');
      text.split('\n').forEach((line, i) => {
        // Skip comment lines — a token named in prose is not a usage.
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;

        for (const match of line.matchAll(RAW_COLOR_SCALES)) {
          offenders.push({ file, line: i + 1, token: match[0] });
        }
      });
    }
  });

  it('finds no raw colour utilities outside the allowlist', () => {
    const allowed = new Set(ALLOWLIST.map((a) => a.file));
    const violations = offenders.filter((o) => !allowed.has(o.file));

    if (violations.length > 0) {
      const report = violations
        .slice(0, 40)
        .map((v) => `  ${v.file}:${v.line}  ${v.token}`)
        .join('\n');
      const more = violations.length > 40 ? `\n  …and ${violations.length - 40} more` : '';
      throw new Error(
        `${violations.length} raw Tailwind colour utilities found. Use a semantic ` +
          `token (bg-bg-*, text-content-*, border-border-*, bg-brand-*) instead:\n` +
          `${report}${more}`,
      );
    }

    expect(violations).toHaveLength(0);
  });

  it('keeps the allowlist at or below the P02 cap of 3 (ratchet-only)', () => {
    expect(ALLOWLIST.length).toBeLessThanOrEqual(3);
  });

  it('has no stale allowlist entries', () => {
    // An allowlisted file that no longer offends must be removed, or the
    // ratchet quietly stops ratcheting.
    const offending = new Set(offenders.map((o) => o.file));
    const stale = ALLOWLIST.filter((a) => !offending.has(a.file)).map((a) => a.file);
    expect(stale).toEqual([]);
  });
});
