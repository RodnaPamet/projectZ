import { readFileSync, globSync } from 'node:fs';

import ts from 'typescript';

/**
 * USER-FACING COPY COMES FROM THE CATALOGUE, NOT FROM JSX.
 *
 * ═══ WHY ═══
 *
 * playerz.bg ships in Bulgarian. A string typed straight into a component is
 * English for ever: it is not in `messages/bg.json`, so no translator sees it,
 * the completeness guard cannot miss it, and the Cyrillic ratchet — which only
 * reads the catalogue — cannot either. It renders in English to every user, on
 * a page where everything around it is Bulgarian.
 *
 * That is exactly how the repo got here. `<h1>Play</h1>`,
 * `title="No venues match your search"` and `aria-label="Loading dashboard"`
 * all shipped while two locale catalogues sat beside them at full parity.
 *
 * ═══ AST, NOT A LINE REGEX ═══
 *
 * A text scan cannot tell `<h1>Play</h1>` from a TypeScript generic
 * (`Promise<T>`), a ternary fragment (`{width && height ? (`) or a doc
 * comment. Measured on this tree, a regex version reported 41 hits of which
 * roughly half were syntax. The AST reads JSX text nodes and a fixed set of
 * copy-carrying attributes, and sees none of that.
 */

/** Attributes whose string value is read aloud or displayed. */
const COPY_ATTRS = new Set([
  'title',
  'label',
  'placeholder',
  'aria-label',
  'aria-description',
  'description',
  'alt',
  'emptyTitle',
  'emptyDescription',
]);

/**
 * Files exempt, each for a stated reason.
 *
 * `design-system` is a developer-facing gallery of every primitive, not a
 * product page — it is not linked from the app and its labels name the
 * components rather than speaking to a user.
 */
const EXEMPT: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    pattern: /^src\/app\/\(design\)\/design-system\//,
    why: 'developer-facing component gallery; its copy names primitives, not product concepts',
  },
];

/**
 * Literal strings that are not copy: brands, licences, units, and the
 * single-word technical labels a translator would hand straight back.
 */
const NOT_COPY =
  /^(playerz\.bg|playerz|GNU GPL v3|MIT|Apache|ISO \d+|[A-Z]{2,6}|[\d\s.,:/%+-]+|[a-z-]+)$/;

const FILES = globSync('src/**/*.tsx')
  .map((f) => f.toString())
  .filter((f) => !EXEMPT.some((e) => e.pattern.test(f)));

interface Finding {
  file: string;
  line: number;
  text: string;
}

function copyLiterals(file: string, src: string): Finding[] {
  const sourceFile = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: Finding[] = [];

  const at = (node: ts.Node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  /** Two or more words, or one capitalised word — i.e. something a human reads. */
  const isCopy = (raw: string): boolean => {
    const text = raw.trim();
    if (text.length < 3) return false;
    if (!/[a-zA-Z]/.test(text)) return false;
    if (NOT_COPY.test(text)) return false;
    return /\s/.test(text) || /^[A-Z][a-z]/.test(text);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && isCopy(node.text)) {
      found.push({ file, line: at(node), text: node.text.trim() });
    }

    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      const init = node.initializer;
      if (COPY_ATTRS.has(name) && init && ts.isStringLiteral(init) && isCopy(init.text)) {
        found.push({ file, line: at(node), text: `${name}="${init.text}"` });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

/**
 * ═══ THE BLIND SPOT THIS CLOSES ═══
 *
 * The scan above is an AST walk over JSX: text nodes and copy-carrying
 * ATTRIBUTES. `AppNav` shipped nine literal English strings past it — 'Play',
 * 'Calendar', 'Courts', 'Pricing', 'Staff' and four more — on the most visible
 * surface in an app whose default locale is Bulgarian.
 *
 * They were invisible because they lived in a plain object literal at module
 * scope (`{ href: '/admin/courts', label: 'Courts' }`) and rendered as
 * `{item.label}` — a JSX *expression*, not a text node. Copy declared in a data
 * structure and rendered through a variable escapes both halves of the rule.
 *
 * ═══ WHY THIS RULE IS NARROW ═══
 *
 * The obvious generalisation — flag every object-literal `label`/`title`/
 * `description` with a string value — was MEASURED on this tree: 203 hits, and
 * most of them legitimate. Prometheus metric descriptions, zod error messages,
 * NextAuth credential field labels. A guardrail with 200 exemptions is a list
 * somebody stops reading.
 *
 * So this targets the shape that actually shipped: an object literal carrying
 * BOTH `href` and a copy field. That is a navigation item, its text is always
 * user-facing, and there is no legitimate reason for it to be a literal.
 */
const NAV_COPY_KEYS = new Set(['label', 'title', 'text']);

describe('navigation copy is never a literal', () => {
  const files = globSync('src/**/*.{ts,tsx}').map((f) => f.toString());

  interface NavFinding {
    file: string;
    line: number;
    text: string;
  }

  function navLiterals(file: string, src: string): NavFinding[] {
    const sourceFile = ts.createSourceFile(
      file,
      src,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const found: NavFinding[] = [];

    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const props = node.properties.filter(ts.isPropertyAssignment);
        const nameOf = (n: ts.PropertyAssignment) =>
          ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) ? n.name.text : '';

        const hasHref = props.some((pr) => nameOf(pr) === 'href');
        if (hasHref) {
          for (const pr of props) {
            const key = nameOf(pr);
            if (
              NAV_COPY_KEYS.has(key) &&
              ts.isStringLiteral(pr.initializer) &&
              // A key like 'myBookings' is the fix, not the defect. Copy has a
              // space or starts a sentence; a key is one camelCase word.
              /\s/.test(pr.initializer.text)
            ) {
              found.push({
                file,
                line: sourceFile.getLineAndCharacterOfPosition(pr.getStart(sourceFile)).line + 1,
                text: `${key}: '${pr.initializer.text}'`,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return found;
  }

  it('the scan reads the source tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  // The exemption that used to live here is GONE.
  //
  // `canonical-parents.ts` carried 13 literal labels — "Internal Audit", "NIS2
  // Gap Assessment", "Access reviews" — exempted with the count pinned so it
  // could not quietly grow, and so that fixing it would force the number down.
  //
  // #176 emptied that map, the pin failed with 13 → 0, and the exemption came
  // out. That is the ratchet completing its job rather than being defeated: it
  // held the line, then made its own removal the next obvious step.
  it('no nav item carries literal copy', () => {
    const findings = files.flatMap((f) => navLiterals(f, readFileSync(f, 'utf8')));

    if (findings.length > 0) {
      throw new Error(
        `Navigation items with literal copy:\n\n` +
          findings.map((f) => `  ${f.file}:${f.line}  ${f.text}`).join('\n') +
          `\n\nThis app's default locale is Bulgarian. A nav label written in the source\n` +
          `is English on every screen, and the JSX scan above cannot see it because the\n` +
          `string lives in a data structure rather than in markup.\n\n` +
          `Carry a KEY instead and resolve it at render — see NavItem.labelKey in\n` +
          `src/components/layout/AppNav.tsx, and add the key to messages/bg.json and\n` +
          `messages/en.json.`,
      );
    }
  });

  // ── Negative control ───────────────────────────────────────────────
  it('the detector fires on the shape that shipped, and not on a key', () => {
    // Passing by finding nothing is indistinguishable from a detector that
    // matches nothing — which is what this became the day it was written.
    const bad = navLiterals(
      't.tsx',
      `const NAV = [{ href: '/admin/courts', label: 'Open play' }];`,
    );
    expect(bad).toHaveLength(1);

    // A translation key is the fix, so it must NOT be flagged.
    expect(
      navLiterals('t.tsx', `const NAV = [{ href: '/admin/courts', labelKey: 'courts' }];`),
    ).toEqual([]);
    expect(navLiterals('t.tsx', `const NAV = [{ href: '/venues', label: 'myBookings' }];`)).toEqual(
      [],
    );

    // An object with copy but no href is out of scope — that is the 203-hit
    // generalisation this rule deliberately does not attempt.
    expect(navLiterals('t.tsx', `const m = { label: 'Total requests handled' };`)).toEqual([]);
  });
});

describe('no hardcoded user-facing copy', () => {
  it('the scan reads the component tree', () => {
    // A broken glob, or a parser that yields no JSX, makes this vacuous.
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.some((f) => f.startsWith('src/app/'))).toBe(true);
  });

  it('every exemption still matches something', () => {
    // An exemption for a deleted path is a hole waiting for that path to come
    // back, and it would never fail on its own.
    for (const { pattern } of EXEMPT) {
      expect(globSync('src/**/*.tsx').some((f) => pattern.test(f.toString()))).toBe(true);
    }
  });

  it('no component carries a literal sentence', () => {
    const findings = FILES.flatMap((f) => copyLiterals(f, readFileSync(f, 'utf8')));

    if (findings.length > 0) {
      throw new Error(
        `${findings.length} hardcoded string(s) that a Bulgarian user would see in English:\n\n` +
          findings.map((f) => `  ${f.file}:${f.line}\n    ${f.text}`).join('\n') +
          `\n\nPut it in messages/bg.json and messages/en.json and read it with\n` +
          `useTranslations() — or getTranslations() in an async server component.\n\n` +
          `A string typed into a component is English for ever: no translator\n` +
          `sees it, and neither the completeness guard nor the Cyrillic ratchet\n` +
          `can reach it, because both only read the catalogue.`,
      );
    }
  });
});

describe('the i18n provider is mounted, and the locale is resolved not assumed', () => {
  const LAYOUT = 'src/app/layout.tsx';
  const REQUEST = 'src/lib/i18n/request.ts';

  it('the root layout wraps the tree in NextIntlClientProvider', () => {
    // Every primitive that calls useTranslations() throws without it. A layout
    // refactor that drops the provider takes the whole app down, so it is
    // worth one assertion rather than a stack trace in production.
    const src = readFileSync(LAYOUT, 'utf8');

    expect(src).toMatch(/NextIntlClientProvider/);
    expect(src).toMatch(/lang=\{locale\}/);
  });

  it('the request config READS the locale rather than hardcoding one', () => {
    // It was `const locale = DEFAULT_LOCALE;` — a constant. Bulgarian was
    // right by accident, and nothing a user did could change it: not the
    // `User.locale` column, not a cookie, not a header.
    const src = readFileSync(REQUEST, 'utf8');

    expect(src).toMatch(/cookies\(\)/);
    expect(src).toMatch(/LOCALE_COOKIE/);
    // And it validates what it read — `messages/${locale}.json` is a dynamic
    // import, so an unvalidated cookie is a path traversal.
    expect(src).toMatch(/isLocale/);
  });

  it('Bulgarian is the default', () => {
    // The product ships in Bulgarian. If this flips, every page a first-time
    // visitor sees flips with it.
    const src = readFileSync('src/lib/i18n/locales.ts', 'utf8');

    expect(src).toMatch(/DEFAULT_LOCALE: Locale = 'bg'/);
  });
});
