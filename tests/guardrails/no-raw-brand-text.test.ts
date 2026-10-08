import { readFileSync, globSync } from 'node:fs';

import ts from 'typescript';

/**
 * BRAND-COLOURED TEXT IS `text-content-brand`. NEVER A BRAND FILL OR SHADE.
 *
 * ═══ WHY ═══
 *
 * No brand colour is body text in both themes (#233). Measured with
 * src/lib/design/contrast.ts against each theme's page background, for the
 * #362 fills (purple in dark, inflect's orange one step darker in light):
 *
 *   fill               light  #f4f2ed    dark  #0b0b12
 *   --brand-muted          4.63 ✓            4.26 ✗
 *   --brand-default        5.07 ✓            4.00 ✗
 *   --brand-emphasis       6.53 ✓            3.29 ✗
 *
 * The fixed shades this rule was written for (`text-brand-NNN`, the green
 * palette, where brand-600 was 4.48:1 on the light page and 3.79:1 on the dark
 * one) were deleted from tailwind.config.ts in #362, and a class that names one
 * now compiles to nothing; the ban stays so neither kind comes back. Text in a
 * fill colour gets through review because passing contrast depends on the
 * colour AND the size, and a class name only states the colour.
 * `text-brand-600 text-4xl` on the homepage cleared the 3:1 large-text bar. The
 * same class at 16px in a header was an axe violation, short by 0.02.
 *
 * `text-content-brand` carries its own shade per theme (violet-400 dark,
 * inflect's #b83d00 light), and tests/guardrails/contrast.test.ts pins it at
 * 7.21:1 and 5.07:1.
 * A `dark:` variant cannot do the same job. No `darkMode` is configured, so
 * `dark:` compiles to `@media (prefers-color-scheme: dark)` and follows the OS,
 * while the app follows [data-theme]. Anyone whose two settings differ gets the
 * wrong shade.
 *
 * ═══ WHAT IS BANNED, AND WHAT IS NOT ═══
 *
 * Banned: the two utilities that colour GLYPHS from a fixed palette (deleted in
 * #362, so these compile to nothing today). What each compiled to was checked
 * against this repo's Tailwind:
 *
 *   text-brand-NNN          → color
 *   placeholder-brand-NNN   → &::placeholder { color }
 *
 * and, since #246, the same two utilities over a `--brand-<name>` FILL token
 * written as an arbitrary value, in both of Tailwind 4's spellings:
 *
 *   text-[var(--brand-default)]   text-(--brand-default)   → color: var(--brand-default)
 *
 * The fill tokens were tuned as fills. #246 measured `--brand-default` as text
 * at 2.95:1 on the light page and `--brand-emphasis` initials at 4.23 / 3.97
 * on `--brand-subtle`. All six sites were in the ported library and T28
 * deleted or rewrote them, so this part of the rule starts at zero too.
 *
 * This includes any variant (`hover:`, `md:`, `placeholder:`, `[&_a]:`), any
 * opacity (`/80`, which only lowers the ratio further) and `!`.
 *
 * Not banned, on purpose:
 *
 *   bg- border- ring- outline- divide- shadow- accent- from- via- to-
 *       These are FILLS and boundaries, and #233 keeps the brand for them.
 *   fill- stroke-
 *       SVG marks. Non-text, so the bar is 3:1, and the brand fills clear it in
 *       both themes (--brand-default 5.07 light / 4.00 dark).
 *   decoration-  → text-decoration-color. It colours the underline, not the letters.
 *   caret-       → caret-color. The insertion caret is a non-text indicator.
 *   text-brand-{default,emphasis,muted,subtle}
 *       The SEMANTIC fill tokens. Each current use sets currentColor for an
 *       SVG chart mark or the radio dot, both non-text. Using one to colour
 *       words is still wrong; the arbitrary-value form of the same thing is
 *       banned above (#246).
 *
 *       (Do not abbreviate that class with a `*` in this file. Tailwind scans
 *       tests/ too, and a wildcard inside the brackets compiles to a rule whose
 *       value is not valid CSS. Next's parser then rejects globals.css, so every
 *       page returns 500. Measured: it did exactly that while this rule was
 *       being written.)
 *
 * ═══ AST, NOT A LINE REGEX ═══
 *
 * A class name only ever lives in a string: a JSX attribute, an argument to
 * cn() / clsx() / cva(), a template literal, an object key. The AST walks those
 * and never visits a comment. On this tree a line regex also flags
 * src/components/layout/SiteHeader.tsx, where a JSX comment explains why NOT to
 * write `text-brand-600`. A guard that punishes the docs for describing the rule
 * gets deleted within a week (see no-native-select). A naive `//` stripper would
 * also miss a class that follows a URL on the same line.
 *
 * CSS is read as well, with its comments blanked, because `@apply` is the other
 * place a class name can go.
 *
 * ═══ THE ALLOWLIST IS EMPTY ═══
 *
 * The homepage wordmark was the only real usage, and it moved to
 * `text-content-brand` together with this rule. With nothing left to baseline,
 * the next one fails the build.
 */

/**
 * A glyph-colour utility over the FIXED brand palette, or over a `--brand-*`
 * fill token as an arbitrary value (#246). The same regex as
 * scripts/ui-sync/portable-rules.mjs's brand-text rule, so an upstream author
 * sees the failure before the copy lands here.
 */
const BRAND_TEXT =
  /(?<![\w-])(?:text|placeholder)-(?:brand-\d{2,3}|\[var\(--brand-[\w-]+\)\]|\(--brand-[\w-]+\))(?![\w-])/g;

const CODE = globSync('src/**/*.{ts,tsx,js,jsx}').map((f) => f.toString());
const CSS = globSync('src/**/*.css').map((f) => f.toString());

interface Finding {
  file: string;
  line: number;
  token: string;
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (file.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Every string literal and template part in a file, with the SOURCE text (not
 * the cooked value), so a match inside a multi-line template reports its own
 * line rather than the line the template started on.
 */
function stringsIn(file: string, src: string): Array<{ line: number; raw: string }> {
  const sourceFile = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKind(file));
  const found: Array<{ line: number; raw: string }> = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const start = node.getStart(sourceFile);
      found.push({
        line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
        raw: node.getText(sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

/** CSS with every comment blanked, newlines kept so line numbers hold. */
function cssCode(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

function findingsIn(file: string, src: string): Finding[] {
  const found: Finding[] = [];

  const scan = (text: string, firstLine: number) => {
    for (const match of text.matchAll(BRAND_TEXT)) {
      const newlines = text.slice(0, match.index).split('\n').length - 1;
      found.push({ file, line: firstLine + newlines, token: match[0] });
    }
  };

  if (file.endsWith('.css')) {
    scan(cssCode(src), 1);
  } else {
    for (const { line, raw } of stringsIn(file, src)) scan(raw, line);
  }

  return found;
}

describe('the scan is not vacuous', () => {
  it('found the source tree, and the stylesheets', () => {
    // A broken glob makes every assertion below trivially true.
    expect(CODE.length).toBeGreaterThan(100);
    expect(CSS).toEqual(expect.arrayContaining(['src/app/globals.css', 'src/styles/tokens.css']));
  });

  it('the AST walk reaches the class strings the rule is about', () => {
    // If `stringsIn` saw nothing (a wrong ScriptKind, a visitor that stops at the
    // root), the ban would pass by reading an empty tree. So: a className we
    // KNOW is there, found through the same walk the ban uses.
    const page = stringsIn(
      'src/app/(home)/page.tsx',
      readFileSync('src/app/(home)/page.tsx', 'utf8'),
    );
    expect(page.some((s) => s.raw.includes('text-content-brand'))).toBe(true);

    const total = CODE.reduce((n, f) => n + stringsIn(f, readFileSync(f, 'utf8')).length, 0);
    expect(total).toBeGreaterThan(5_000);
  });
});

describe('no fixed brand shade colours text, anywhere in src/', () => {
  it('has none, and the allowlist is empty on purpose', () => {
    const findings = [...CODE, ...CSS].flatMap((f) => findingsIn(f, readFileSync(f, 'utf8')));

    if (findings.length > 0) {
      throw new Error(
        `Brand-palette TEXT colour:\n\n` +
          findings.map((f) => `  ${f.file}:${f.line}  ${f.token}`).join('\n') +
          `\n\nNo brand fill is body text in both themes. --brand-default is 4.00:1 on the\n` +
          `dark page (5.07:1 on the light one), and the class cannot say how big the\n` +
          `text is, which decides whether it passes.\n\n` +
          `Use text-content-brand. It changes shade with the theme, and\n` +
          `tests/guardrails/contrast.test.ts pins it at 5.07:1 light, 7.21:1 dark.\n\n` +
          `Fills are fine: bg-brand-emphasis, border-[var(--brand-default)]. A dark:\n` +
          `variant is not a fix, because dark: follows the OS and this app follows\n` +
          `[data-theme].`,
      );
    }
  });

  it('the replacement exists and is measured, so the rule is actionable', () => {
    // A ban that points at a token must point at a real, MEASURED token: a
    // replacement nobody checks is just a different way to ship 4.00:1.
    expect(readFileSync('tailwind.config.ts', 'utf8')).toMatch(/brand:\s*'var\(--content-brand\)'/);

    const declarations = cssCode(readFileSync('src/styles/tokens.css', 'utf8')).match(
      /--content-brand\s*:/g,
    );
    expect(declarations).toHaveLength(2); // one per theme

    const contrast = readFileSync('tests/guardrails/contrast.test.ts', 'utf8');
    expect(contrast).toMatch(/fg: '--content-brand',\s*bg: '--bg-page'/);
  });
});

// ── Negative controls ────────────────────────────────────────────────

describe('the rule fires on the code it forbids', () => {
  const tokensIn = (src: string, file = 't.tsx') => findingsIn(file, src).map((f) => f.token);

  it.each([
    ['a JSX className', `<h1 className="text-brand-600 text-4xl">x</h1>`],
    ['a cn() argument', `cn('font-semibold', 'text-brand-600')`],
    ['a clsx() object key', `clsx({ 'text-brand-700': active })`],
    ['a cva() array entry', `cva(['hover:text-brand-600'])`],
    ['a template head', 'const c = `text-brand-500 ${extra}`;'],
    ['a template tail', 'const c = `flex ${extra} text-brand-500`;'],
    ['a plain template', 'const c = `text-brand-500`;'],
    ['stacked variants and opacity', `'md:hover:text-brand-600/80'`],
    ['an arbitrary variant', `'[&_a]:text-brand-600'`],
    ['important, prefix', `'!text-brand-600'`],
    ['important, suffix', `'text-brand-600!'`],
    ['the placeholder utility', `'placeholder-brand-500'`],
    ['the placeholder variant', `'placeholder:text-brand-500'`],
    ['the lightest shade', `'text-brand-50'`],
    ['the darkest shade', `'text-brand-950'`],
    ['a class after a URL on the same line', `<a href="https://x.bg" className="text-brand-600">`],
  ])('catches %s', (_label, src) => {
    expect(tokensIn(src)).toHaveLength(1);
  });

  // #246, the arbitrary-value forms. Assembled from two halves, so Tailwind's
  // scan of this file never sees (and compiles) a whole class.
  const ARB = 'text-[var(--brand-' + 'default)]';
  const PAREN = 'text-(--brand-' + 'emphasis)';
  it.each([
    ['var() in brackets', `<p className="${ARB}" />`, ARB],
    ['the v4 parenthesis shorthand', `<p className="${PAREN}" />`, PAREN],
    ['with a variant', `cn('hover:${ARB}')`, ARB],
    ['with opacity', `cn('${PAREN}/80')`, null],
    ['the placeholder utility', "cn('placeholder-[var(--brand-" + "muted)]')", null],
    ['in @apply', `.x { @apply ${PAREN}; }`, PAREN],
  ])('catches the #246 form: %s', (_label, src, token) => {
    const file = src.startsWith('.x') ? 't.css' : 't.tsx';
    const found = tokensIn(src, file);
    expect(found).toHaveLength(1);
    if (token) expect(found[0]).toBe(token);
  });

  it.each([
    // The same tokens as fills stay legal: #233 keeps fills on the palette.
    'bg-[var(--brand-' + 'default)]',
    'border-(--brand-' + 'emphasis)',
    // Not a brand token.
    'text-[var(--content-' + 'brand)]',
    'text-(--content-' + 'muted)',
  ])('does NOT flag the fill or a non-brand token: %s', (good) => {
    expect(tokensIn(`<p className="${good}" />`)).toEqual([]);
  });

  it('catches @apply in CSS', () => {
    expect(tokensIn('.x {\n  @apply text-brand-600 font-semibold;\n}', 't.css')).toEqual([
      'text-brand-600',
    ]);
  });

  it('reports the line of the match, not the line a template started on', () => {
    const src = 'const c = `flex\n  gap-2\n  text-brand-600`;';
    expect(findingsIn('t.tsx', src)).toEqual([{ file: 't.tsx', line: 3, token: 'text-brand-600' }]);
  });

  it.each([
    // Fills and non-text colours over the palette. #233 keeps these.
    'bg-brand-600',
    'border-brand-600',
    'ring-brand-500',
    'from-brand-500',
    'fill-brand-600',
    'stroke-brand-600',
    'decoration-brand-600',
    'caret-brand-600',
    // The replacement, and the semantic fill tokens (non-text uses today; #246).
    'text-content-brand',
    'text-brand-emphasis',
    'text-brand-default',
    // Not Tailwind classes at all: the boundary must hold on both sides.
    'hero-text-brand-600',
    'subtext-brand-600',
    'text-brand-6000',
  ])('does NOT flag %s', (good) => {
    expect(tokensIn(`<p className="${good}" />`)).toEqual([]);
  });

  it('a class named in a COMMENT is prose, not a usage', () => {
    // SiteHeader.tsx does exactly this: it explains why NOT to write the class.
    expect(tokensIn(`// never text-brand-600\nconst x = 1;`)).toEqual([]);
    expect(tokensIn(`/* text-brand-600 */\nconst x = 1;`)).toEqual([]);
    expect(tokensIn(`<div>{/* NOT text-brand-600 */}</div>`)).toEqual([]);
    expect(tokensIn('.x { color: red; } /* text-brand-600 */', 't.css')).toEqual([]);

    // …but a real one next to the comment still is.
    expect(tokensIn(`// replaces text-brand-600\n<h1 className="text-brand-600" />`)).toEqual([
      'text-brand-600',
    ]);
  });
});
