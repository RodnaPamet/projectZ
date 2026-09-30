import { readFileSync } from 'node:fs';

/**
 * DOCUMENT SCROLL LOCK — OPT-IN, NEVER GLOBAL.
 *
 * Adapted from inflect's tests/guards/document-scroll-lock.test.ts, with the
 * one difference that matters here.
 *
 * inflect locks html/body to the viewport at md+ unconditionally, because
 * every inflect page lives in an AppShell whose inner container owns the
 * scroll. The lock came across with the port, but the shell did not: no
 * playerz page renders a scroll container, so at 1280px the document simply
 * could not scroll — /design-system's lower half was unreachable by wheel,
 * PageDown or trackpad. The only desktop e2e passed because it scrolled
 * programmatically, which ignores `overflow: hidden`.
 *
 * So here the lock applies only when the page opts in with `[data-scroll-root]`
 * (the club-admin shell, T19). These assertions keep both halves:
 *
 *   - a shell that opts in still gets inflect's contract (height-locked, the
 *     inner container scrolls, "the page scrolls" is impossible);
 *   - a page that does not is never locked — the regression this fixes.
 *
 * tests/e2e/desktop-scroll.spec.ts proves the same thing in a real browser.
 */

/** Blank CSS comments, so a rule that was COMMENTED OUT cannot satisfy an assertion. */
const cssCode = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

const CSS = cssCode(readFileSync('src/app/globals.css', 'utf8'));

/** Every top-level `@media <query> { … }` block (closing brace at column 0). */
function mediaBlocks(css: string, query: RegExp): string[] {
  return [...css.matchAll(/@media\s*([^{]+)\{[\s\S]*?\n\}/g)]
    .filter((m) => query.test(m[1]!))
    .map((m) => m[0]);
}

describe('document scroll lock — globals.css contract', () => {
  it('at md+, a page that opts in with [data-scroll-root] is height-locked and overflow-hidden', () => {
    const md = mediaBlocks(CSS, /\(\s*min-width:\s*768px\s*\)/);
    const lock = md.find((b) => /overflow:\s*hidden/.test(b));

    expect(lock).toBeDefined();
    expect(lock).toMatch(/html:has\(\[data-scroll-root\]\)\s*,/);
    expect(lock).toMatch(/html:has\(\[data-scroll-root\]\)\s+body\s*\{/);
    expect(lock).toMatch(/height:\s*100%/);
  });

  it('the lock exists ONLY under :has([data-scroll-root])', () => {
    // Walk every rule that hides overflow on the document. Each selector in its
    // list must be scoped to a page that owns a scroll root — a bare `html` or
    // `body` is the unscrollable-desktop bug coming back.
    const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const docLocks = rules
      .filter(([, , body]) => /overflow(?:-y)?:\s*hidden/.test(body!))
      .flatMap(([, selectors]) => selectors!.split(','))
      .map((s) => s.trim())
      .filter((s) => /^(?:html|body)\b/.test(s));

    expect(docLocks.length).toBeGreaterThan(0);
    for (const selector of docLocks) {
      expect(selector).toMatch(/^html:has\(\[data-scroll-root\]\)(?:\s+body)?$/);
    }
  });

  it('print mode releases the lock (the full document prints)', () => {
    const printBlocks = mediaBlocks(CSS, /^\s*print\s*$/);
    const releases = printBlocks.some(
      (b) =>
        /html\s*,\s*body/.test(b) &&
        /height:\s*auto\s*!important/.test(b) &&
        /overflow:\s*visible\s*!important/.test(b),
    );

    expect(releases).toBe(true);
  });

  it('mobile (<md) is never locked', () => {
    // Defence against a "simplify" that drops the @media wrapper.
    expect(CSS).not.toMatch(/^html\s*,\s*body\s*\{[^}]*overflow:\s*hidden/m);
    expect(CSS).not.toMatch(/^html:has\(\[data-scroll-root\]\)[^{]*\{[^}]*overflow:\s*hidden/m);
  });
});

// ── Negative controls ────────────────────────────────────────────────

describe('the rules fire on the CSS they forbid', () => {
  it('a commented-out lock does not count', () => {
    expect(cssCode('/* html { overflow: hidden } */')).not.toMatch(/overflow/);
  });

  it('an unscoped md+ lock is caught', () => {
    const bad = '@media (min-width: 768px) {\n  html,\n  body {\n    overflow: hidden;\n  }\n}';
    const selectors = [...bad.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , body]) => /overflow:\s*hidden/.test(body!))
      .flatMap(([, s]) => s!.split(','))
      .map((s) => s.trim());

    expect(selectors).toContain('html');
    expect(selectors.every((s) => /^html:has\(\[data-scroll-root\]\)/.test(s))).toBe(false);
  });
});
