import { globSync, readFileSync, readdirSync } from 'node:fs';

import ts from 'typescript';

import { readAllRows } from '../../scripts/ui-sync/manifest.mjs';
import { checkRows } from '../../scripts/ui-sync/portable-rules.mjs';
import {
  COMMENT_RE,
  COPY_RE,
  SECTION_RE,
  identifierWords,
  termsIn,
} from '../helpers/foreign-vocabulary';
import { treeFiles } from '../helpers/scan-floor';

/**
 * NO COMPLIANCE-PRODUCT VOCABULARY IN PLAYERZ (T29).
 *
 * The owner's rule for the port is "only the UI, not the pages or vocabulary".
 * playerz copied inflect-compliance's component library, and with it came the
 * other product's words: T28 (#225) measured 439 of 488 component files that
 * nothing imported, many of them compliance screens, and deleted them. What is
 * left is either a vendored copy (locked by hash, fixed upstream) or playerz's
 * own code. This guard covers both, so the words cannot come back through
 * either door.
 *
 * ═══ TWO SCOPES, TWO STRICTNESSES ═══
 *
 * Vendored files (every manifest row: vendored, pending and local-diff). The
 * strict upstream portability list (scripts/ui-sync/portable-rules.mjs
 * VOCABULARY: controls, risks, evidence, audit…, coverage, clause, SoA,
 * ISO 27001, the brands Inflect, PwC, METRO and Dub) in comments, strings and
 * JSX text. ui-sync-manifest.test.ts already fails a 'vendored' row; this adds
 * the 351 'pending' rows, whose 13 remaining hits are allow-listed below with
 * the upstream issue that removes them. A copy is never edited here.
 *
 * playerz-owned files (src/** minus the manifest rows, both catalogues, the
 * route tree):
 *
 *   copy        string literals and JSX text, catalogue keys and values, route
 *               segments and exported identifiers: the compliance nouns in
 *               COMPLIANCE_TERMS (EN and BG) and the brands;
 *   sections    framework / vendor / control(s) / контроли as a route segment,
 *               a catalogue key segment, or a catalogue value that is only the
 *               word (a section name in a nav);
 *   comments    only the unambiguous phrases (ISO 27001, ISMS, SoA, NIS2, SOX,
 *               GRC, risk register, risk matrix, inherent or residual risk,
 *               control coverage, audit cycle) and the brands. playerz's own
 *               comments say "WHERE clause", "readiness probe", "finding" and
 *               "vendored", and those are not borrowed words.
 *
 * ═══ THE ALLOW-LIST ═══
 *
 * An entry names a file, a pattern the offending LINE matches, and why. An
 * entry that no longer matches anything fails, so the list only shrinks.
 */

interface Allowed {
  file: string;
  line: RegExp;
  reason: string;
}

const PENDING_UPSTREAM =
  'pending row, a stale 2026-07 copy; upstream comment to neutralise, ' +
  'https://github.com/RodnaPamet/inflect-compliance/issues/3133';

const ALLOWED: Allowed[] = [
  // The HKDF info strings and salt that derive the field-encryption keys. They
  // are inputs to the key derivation, not words: changing one makes every
  // encrypted column unreadable.
  {
    file: 'src/lib/security/encryption.ts',
    line: /'inflect-data-(?:encryption|lookup-hash|protection-salt-v1)'/,
    reason: 'key-derivation constant; renaming it orphans every encrypted value',
  },
  {
    file: 'src/lib/security/encryption-constants.ts',
    line: /'inflect-dev-encryption-key-not-for-production-use!!'/,
    reason: 'the dev fallback key; renaming it orphans every locally encrypted value',
  },
  // Stale pending copies whose upstream file still says it.
  {
    file: 'src/components/ui/hooks/index.ts',
    line: /inflect|coverage|Audit/i,
    reason: PENDING_UPSTREAM,
  },
  {
    file: 'src/components/ui/hooks/use-copy-to-clipboard.tsx',
    line: /audit/i,
    reason: PENDING_UPSTREAM,
  },
  {
    file: 'src/components/ui/hooks/use-cursor-pagination.ts',
    line: /controls/i,
    reason: PENDING_UPSTREAM,
  },
  {
    file: 'src/components/ui/hooks/use-optimistic-update.ts',
    line: /risks/i,
    reason: PENDING_UPSTREAM,
  },
  {
    file: 'src/components/ui/hooks/use-threshold-load-more.ts',
    line: /controls|risks|evidence/i,
    reason: PENDING_UPSTREAM,
  },
  {
    file: 'src/components/ui/hooks/use-view-mode.ts',
    line: /controls|inflect/i,
    reason: PENDING_UPSTREAM,
  },
  { file: 'src/components/ui/icons/index.tsx', line: /\bdub\b/i, reason: PENDING_UPSTREAM },
];

interface Finding {
  file: string;
  line: number;
  scope: string;
  term: string;
  text: string;
}

// ─── The scan ──────────────────────────────────────────────────────────

const ROWS = readAllRows('.') as Array<{ path: string; status: string }>;
const ROW_PATHS = new Set(ROWS.map((r) => r.path));
const SOURCE = globSync('src/**/*.{ts,tsx,js,jsx,mjs,css}').map(String).sort();
const OWNED = SOURCE.filter((f) => !ROW_PATHS.has(f));

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const lineAt = (text: string, index: number) => text.slice(0, index).split('\n').length;
const lineText = (text: string, line: number) => text.split('\n')[line - 1] ?? '';

/**
 * Comments, strings and exported names of one file. Comments are the gaps
 * between the tokens the PARSER produced, so `//` inside JSX text or a URL is
 * never taken for one (the same approach as portable-rules.mjs).
 */
function partsOf(file: string, text: string) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const tokens: ts.Node[] = [];
  const walk = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return;
    const kids = node.getChildren(sf);
    if (kids.length === 0) tokens.push(node);
    else for (const k of kids) walk(k);
  };
  walk(sf);

  const comments: Array<{ start: number; text: string }> = [];
  let at = 0;
  for (const t of tokens) {
    const start = t.getStart(sf);
    if (start > at) comments.push({ start: at, text: text.slice(at, start) });
    at = Math.max(at, t.end);
  }
  const strings = tokens
    .filter(
      (t) =>
        ts.isStringLiteral(t) ||
        ts.isNoSubstitutionTemplateLiteral(t) ||
        ts.isTemplateHead(t) ||
        ts.isTemplateMiddle(t) ||
        ts.isTemplateTail(t) ||
        ts.isJsxText(t),
    )
    // Import specifiers are paths, not copy.
    .filter((t) => !(t.parent && ts.isImportDeclaration(t.parent)))
    .filter((t) => !(t.parent && ts.isExportDeclaration(t.parent)))
    .map((t) => ({ start: t.getStart(sf), text: t.getText(sf) }));

  const exported: Array<{ start: number; name: string }> = [];
  const isExported = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const st of sf.statements) {
    if (
      (ts.isFunctionDeclaration(st) ||
        ts.isClassDeclaration(st) ||
        ts.isInterfaceDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isEnumDeclaration(st)) &&
      st.name &&
      isExported(st)
    )
      exported.push({ start: st.name.getStart(sf), name: st.name.text });
    if (ts.isVariableStatement(st) && isExported(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name))
          exported.push({ start: d.name.getStart(sf), name: d.name.text });
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause))
      for (const e of st.exportClause.elements)
        exported.push({ start: e.name.getStart(sf), name: e.name.text });
  }
  return { comments, strings, exported };
}

/** The findings in one playerz-owned source file. */
function ownedFindings(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const add = (scope: string, index: number, term: string) => {
    const line = lineAt(text, index);
    out.push({ file, line, scope, term, text: lineText(text, line).trim() });
  };

  if (file.endsWith('.css')) {
    for (const c of text.matchAll(/\/\*[\s\S]*?\*\//g))
      for (const m of termsIn(c[0], COMMENT_RE)) add('comment', c.index + m.index, m.term);
    const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    for (const m of termsIn(code, COPY_RE)) add('copy', m.index, m.term);
    return out;
  }

  const { comments, strings, exported } = partsOf(file, text);
  for (const c of comments)
    for (const m of termsIn(c.text, COMMENT_RE)) add('comment', c.start + m.index, m.term);
  for (const s of strings)
    for (const m of termsIn(s.text, COPY_RE)) add('copy', s.start + m.index, m.term);
  for (const e of exported)
    for (const m of termsIn(identifierWords(e.name), COPY_RE)) add('identifier', e.start, m.term);
  return out;
}

type Tree = { [k: string]: string | Tree };

/** Catalogue keys and values, both locales. */
function catalogueFindings(locale: string, tree: Tree): Finding[] {
  const file = `messages/${locale}.json`;
  const out: Finding[] = [];
  const walk = (node: Tree, prefix: string) => {
    for (const [k, v] of Object.entries(node)) {
      const key = prefix ? `${prefix}.${k}` : k;
      const add = (scope: string, term: string) =>
        out.push({ file, line: 0, scope, term, text: `${key}` });
      for (const m of termsIn(identifierWords(k), COPY_RE)) add('catalogue key', m.term);
      if (SECTION_RE.test(k)) add('section key', k);
      if (v && typeof v === 'object') walk(v, key);
      else {
        for (const m of termsIn(String(v), COPY_RE)) add('catalogue value', m.term);
        if (SECTION_RE.test(String(v).trim())) add('section label', String(v));
      }
    }
  };
  walk(tree, '');
  return out;
}

/** Route segments under src/app: `(group)`, `[param]` and plain names alike. */
function routeFindings(dirs: string[]): Finding[] {
  const out: Finding[] = [];
  for (const dir of dirs) {
    for (const raw of dir.split('/').slice(2)) {
      const seg = raw.replace(/^[([]+|[)\]]+$/g, '').replace(/^\.\.\./, '');
      const add = (scope: string, term: string) =>
        out.push({ file: dir, line: 0, scope, term, text: raw });
      for (const m of termsIn(identifierWords(seg), COPY_RE)) add('route segment', m.term);
      if (SECTION_RE.test(seg)) add('section route', seg);
    }
  }
  return [...new Map(out.map((f) => [`${f.file}|${f.term}`, f])).values()];
}

/** The vendored-row findings: check-portable's vocabulary rule over every row. */
function vendoredFindings(): Finding[] {
  const found = checkRows(ROWS, (r: { path: string }) => {
    try {
      return readFileSync(r.path, 'utf8');
    } catch {
      return null;
    }
  }) as Array<{ path: string; line: number; rule: string; text: string }>;
  return found
    .filter((f) => f.rule === 'vocabulary')
    .map((f) => ({
      file: f.path,
      line: f.line,
      scope: 'vendored',
      term: f.text,
      text: lineText(readFileSync(f.path, 'utf8'), f.line).trim(),
    }));
}

const APP_DIRS = readdirSync('src/app', { recursive: true, withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => `${e.parentPath}/${e.name}`.split('\\').join('/'));

function allFindings(): Finding[] {
  return [
    ...OWNED.flatMap((f) => ownedFindings(f, readFileSync(f, 'utf8'))),
    ...(['bg', 'en'] as const).flatMap((l) =>
      catalogueFindings(l, JSON.parse(readFileSync(`messages/${l}.json`, 'utf8')) as Tree),
    ),
    ...routeFindings(APP_DIRS),
    ...vendoredFindings(),
  ];
}

const isAllowed = (f: Finding, a: Allowed) => a.file === f.file && a.line.test(f.text);

// ─── The guard ─────────────────────────────────────────────────────────

describe('the scan is not vacuous', () => {
  it('reads the whole tree, and splits it into vendored and owned', () => {
    expect(SOURCE).toEqual(treeFiles(['src'], /\.(?:ts|tsx|js|jsx|mjs|css)$/));
    expect(ROWS.length).toBeGreaterThan(400);
    // Owned sentinels, and a vendored one that must NOT be in the owned set.
    for (const f of [
      'src/components/layout/nav-items.ts',
      'src/lib/observability/metrics.ts',
      'src/app/globals.css',
    ])
      expect(OWNED).toContain(f);
    expect(OWNED).not.toContain('src/components/ui/button.tsx');
    expect(APP_DIRS).toEqual(expect.arrayContaining(['src/app/(app)/t/[slug]/admin/calendar']));
  });

  it('finds the strings, comments and exports it means to read', () => {
    const parts = partsOf(
      'src/components/layout/nav-items.ts',
      readFileSync('src/components/layout/nav-items.ts', 'utf8'),
    );
    expect(parts.strings.some((s) => s.text === "'sectionVenue'")).toBe(true);
    expect(parts.comments.some((c) => /\S/.test(c.text))).toBe(true);
    expect(parts.exported.map((e) => e.name)).toContain('clubAdminNav');
  });
});

describe('no compliance-product vocabulary', () => {
  const findings = allFindings();

  it('has none outside the allow-list', () => {
    const bad = findings.filter((f) => !ALLOWED.some((a) => isAllowed(f, a)));
    if (bad.length > 0) {
      throw new Error(
        `${bad.length} compliance-product word(s):\n\n` +
          bad
            .map(
              (f) =>
                `  ${f.file}${f.line ? `:${f.line}` : ''}  [${f.scope}] ${f.term}\n      ${f.text}`,
            )
            .join('\n') +
          `\n\nplayerz is a court-booking product that reuses another product's UI, never\n` +
          `its words. Rename it to what playerz calls the thing. In a comment, the\n` +
          `upstream product is "upstream" (docs/ui-sync/README.md).\n\n` +
          `A hit in a VENDORED file is fixed upstream (an inflect PR), then re-copied with\n` +
          `scripts/ui-sync/copy.mjs; until then an ALLOWED entry links that PR.`,
      );
    }
  });

  it('every allow-list entry still matches something and says why', () => {
    for (const a of ALLOWED) {
      expect(a.reason.length).toBeGreaterThan(20);
      expect(findings.some((f) => isAllowed(f, a))).toBe(true);
    }
  });
});

// ── Negative controls ────────────────────────────────────────────────

describe('the rules fire on what they forbid, and only on that', () => {
  const owned = (src: string, file = 'src/x.tsx') =>
    ownedFindings(file, src).map((f) => `${f.scope}:${f.term.toLowerCase()}`);

  it.each([
    ['a JSX text noun', '<p>Upload evidence</p>', 'copy:evidence'],
    ['a string', "const s = 'Risk register';", 'copy:risk register'],
    ['a Bulgarian stem', "const s = 'Доказателства за плащане';", 'copy:доказателства'],
    ['a Bulgarian phrase', "const s = 'оценка на риска';", 'copy:оценка на риска'],
    ['the brand in a string', "const n = 'inflect-compliance';", 'copy:inflect'],
    ['the brand in a comment', '// copied from Inflect\nconst a = 1;', 'comment:inflect'],
    ['a phrase in a comment', '/* the ISO 27001 SoA */\nconst a = 1;', 'comment:iso 27001'],
    ['an exported name', 'export function recordAiRiskAssessment() {}', 'identifier:assessment'],
  ])('catches %s', (_l, src, want) => {
    expect(owned(src)).toContain(want);
  });

  it('reads CSS comments too', () => {
    expect(owned('/* from the Dub port */\n.a { color: red; }', 'src/x.css')).toEqual([
      'comment:dub',
    ]);
  });

  it.each([
    '<input aria-controls="list" />',
    "const label = 'form control';",
    '// the WHERE clause, and the readiness probe on /api/ready',
    '// vendored byte-identical; a finding of the review',
    "const s = 'в съответствие с правилата';",
    "const s = 'на собствен риск';",
    "const s = 'доставчик на плащания';",
    "const s = 'privacy policy and cancellation policy';",
    "const s = 'audit log';",
    '// see https://github.com/RodnaPamet/inflect-compliance/issues/3084',
  ])('does NOT flag %s', (src) => {
    expect(owned(src)).toEqual([]);
  });

  it('section names count only where a section is named', () => {
    expect(
      catalogueFindings('en', { nav: { vendors: 'Vendors', pay: 'Pay the vendor' } }).map(
        (f) => f.scope,
      ),
    ).toEqual(['section key', 'section label']);
    expect(catalogueFindings('bg', { nav: { x: 'Контроли' } }).map((f) => f.scope)).toEqual([
      'section label',
    ]);
    expect(catalogueFindings('en', { a: { b: 'Evidence' } }).map((f) => f.scope)).toEqual([
      'catalogue value',
    ]);
  });

  it('route segments are read through groups and params', () => {
    const found = routeFindings([
      'src/app/(compliance)/x',
      'src/app/t/[slug]/frameworks',
      'src/app/t/[slug]/risk-register',
      'src/app/t/[slug]/admin/calendar',
    ]).map((f) => `${f.scope}:${f.term.toLowerCase()}`);
    expect(found.sort()).toEqual([
      'route segment:compliance',
      'route segment:risk register',
      'section route:frameworks',
    ]);
  });

  it('the allow-list matches by file AND line, not by file alone', () => {
    const f: Finding = {
      file: 'src/lib/security/encryption.ts',
      line: 1,
      scope: 'copy',
      term: 'inflect',
      text: "const X = 'inflect-new-thing';",
    };
    expect(ALLOWED.some((a) => isAllowed(f, a))).toBe(false);
  });
});
