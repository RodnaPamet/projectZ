/**
 * PLAYERZ'S RULES, RUN OVER AN INFLECT FILE BEFORE IT GOES UPSTREAM.
 *
 * Upstream-first means a file is changed in inflect and then copied here byte
 * for byte. If the upstream version breaks one of playerz's guardrails, the copy
 * fails CI here, and the fix needs a second inflect PR. So the upstream author
 * runs check-portable.mjs over the files they touched and fixes what it reports
 * BEFORE opening the PR.
 *
 * Each rule mirrors a playerz guardrail, with the same regex where one exists:
 *
 *   raw-palette      no-raw-tokens            bg-slate-800, text-gray-500 …
 *   english-copy     i18n-no-hardcoded-copy   JSX text, copy attributes, and copy
 *                                             parameter defaults (label = 'Save')
 *   vocabulary       the upstream portability rules: compliance nouns and the
 *                    brands Inflect, PwC, METRO and Dub, in comments, strings,
 *                    JSX text and test names (not identifiers or import paths)
 *   hand-rolled-menu no-hand-rolled-menus     `fixed inset-0` outside ui/modal,
 *                                             ui/sheet and ui/popover, and the
 *                                             anchored-menu idioms beside it
 *   native-select    no-native-select         `<select`, also at the end of a line
 *   motion           motion-safety            inline durations, infinite animations
 *   brand-text       no-raw-brand-text        text-brand-NNN, text-[var(--brand-*)]
 *
 * Pure apart from `typescript` (already a devDependency), so the unit tests can
 * load it under jest.
 */
import ts from 'typescript';

/** no-raw-tokens.test.ts, verbatim. */
const RAW_COLOR_SCALES =
  /\b(?:bg|text|border|ring|fill|stroke|from|via|to|divide|outline|shadow|accent|caret|decoration)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|\d{3})\b/g;

/** no-raw-brand-text.test.ts, plus the arbitrary-value forms #246 adds. */
const BRAND_TEXT =
  /(?<![\w-])(?:text|placeholder)-(?:brand-\d{2,3}|\[var\(--brand-[\w-]+\)\]|\(--brand-[\w-]+\))(?![\w-])/g;

/** no-hand-rolled-menus.test.ts. */
const CLICK_AWAY = /fixed\s+inset-0/;
const FLOATING_MENU = /(?<![:\w-])absolute\b[^"'`]*(?<![:\w-])(?:top-full|bottom-full)\b/;
const MENU_STATE = /\b(?:openMenuId|menuOpenFor|activeMenuId|openRowMenu|showMenuFor)\b/;
const OVERLAY_PRIMITIVES = new Set([
  'src/components/ui/popover.tsx',
  'src/components/ui/modal.tsx',
  'src/components/ui/sheet.tsx',
]);

/** no-native-select.test.ts, with #253's end-of-line case (`<select` then a newline). */
const NATIVE_SELECT = /<select(?:[\s/>]|$)/;

/** motion-safety.test.ts. */
const INLINE_MOTION = /style=\{\{[^}]*(?:animation|transitionDuration|animationDuration)\s*:/g;
const INFINITE = /animation:[^;'"`]*\binfinite\b/g;

/** i18n-no-hardcoded-copy.test.ts. */
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
const NOT_COPY =
  /^(playerz\.bg|playerz|GNU GPL v3|MIT|Apache|ISO \d+|[A-Z]{2,6}|[\d\s.,:/%+-]+|[a-z-]+)$/;

/** A parameter whose default value is shown to the user: `label = 'Save'`. */
const COPY_PARAM =
  /label|title|placeholder|description|text|message|caption|heading|hint|tooltip|^alt$/i;

/**
 * The upstream portability vocabulary (the T03-T08 briefs), case-insensitive,
 * whole words. Plural where the rule is plural: `control` and `risk` are
 * ordinary UI English ("form control", "at your own risk"); `controls` and
 * `risks` are the compliance product's section names.
 */
export const VOCABULARY = [
  'controls',
  'risks',
  'evidence',
  'audit(?:s|ed|ing|ors?)?',
  'policies',
  'vendors',
  'findings',
  'assessments',
  'frameworks',
  'requirements',
  'incidents',
  'assets',
  'posture',
  'readiness',
  'coverage',
  'clauses?',
  'annex(?:es)?',
  'SoA',
  'ISO[\\s/-]*(?:IEC[\\s/-]*)?27001',
  'ISMS',
  'SOX',
  'NIS\\s?2',
  'remediation',
  'likelihood',
  'inherent',
  'residual',
  'Inflect',
  'PwC',
  'METRO',
  'Dub',
];
const VOCAB = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${VOCABULARY.join('|')})(?![\\p{L}\\p{N}_])`,
  'giu',
);
/** ARIA's own attribute: the word is the platform's, not the product's. */
const NOT_VOCAB = /aria-controls/gi;

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

function scriptKind(path) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Comments blanked (newlines kept) — the shape the line-based guards read. */
function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

function isModuleSpecifier(node) {
  const p = node.parent;
  if (!p) return false;
  if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === node)
    return true;
  if (ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p) && p.parent && ts.isImportTypeNode(p.parent)) return true;
  if (ts.isCallExpression(p) && p.arguments[0] === node) {
    const callee = p.expression.getText();
    return (
      p.expression.kind === ts.SyntaxKind.ImportKeyword ||
      /^(?:require|jest\.(?:mock|doMock|requireActual|unstable_mockModule))$/.test(callee)
    );
  }
  return false;
}

/**
 * The parsed file as the rules need it: every token, the comment text between
 * tokens, and the string-bearing tokens. Comments are found as the gaps
 * between tokens the PARSER produced, so `//` inside JSX text or a URL string
 * is never mistaken for one. JSDoc nodes are skipped as tokens, which leaves
 * their text in the gaps where it belongs.
 */
function parse(path, text) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const tokens = [];
  const walk = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return;
    const kids = node.getChildren(sf);
    if (kids.length === 0) tokens.push(node);
    else for (const k of kids) walk(k);
  };
  walk(sf);
  const comments = [];
  let at = 0;
  for (const t of tokens) {
    const start = t.getStart(sf);
    if (start > at) comments.push({ start: at, text: text.slice(at, start) });
    at = Math.max(at, t.end);
  }
  const strings = tokens.filter(
    (t) =>
      (ts.isStringLiteral(t) && !isModuleSpecifier(t)) ||
      ts.isNoSubstitutionTemplateLiteral(t) ||
      ts.isTemplateHead(t) ||
      ts.isTemplateMiddle(t) ||
      ts.isTemplateTail(t) ||
      ts.isJsxText(t),
  );
  return { sf, comments, strings };
}

/** Two or more words, or one capitalised word: i18n-no-hardcoded-copy's test. */
function isCopy(raw) {
  const text = raw.trim();
  if (text.length < 3 || !/[a-zA-Z]/.test(text) || NOT_COPY.test(text)) return false;
  return /\s/.test(text) || /^[A-Z][a-z]/.test(text);
}

function englishCopy(sf) {
  const found = [];
  const add = (node, text) =>
    found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text });
  const literal = (n) =>
    n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;
  /** String literals a JSX expression renders: `{'Save'}`, `{busy ? 'Saving…' : 'Save'}`. */
  const rendered = (n) => {
    if (!n) return [];
    if (ts.isParenthesizedExpression(n)) return rendered(n.expression);
    if (ts.isConditionalExpression(n)) return [...rendered(n.whenTrue), ...rendered(n.whenFalse)];
    if (ts.isBinaryExpression(n)) return [...rendered(n.left), ...rendered(n.right)];
    const s = literal(n);
    return s === null ? [] : [n];
  };

  const visit = (node) => {
    if (ts.isJsxText(node) && isCopy(node.text)) add(node, node.text.trim());
    if (ts.isJsxExpression(node) && node.parent && !ts.isJsxAttribute(node.parent)) {
      for (const s of rendered(node.expression)) if (isCopy(s.text)) add(s, `{'${s.text}'}`);
    }
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && COPY_ATTRS.has(node.name.text)) {
      const init = node.initializer;
      const values =
        init && ts.isJsxExpression(init) ? rendered(init.expression) : init ? [init] : [];
      for (const v of values) {
        const s = literal(v);
        if (s !== null && isCopy(s)) add(node, `${node.name.text}="${s}"`);
      }
    }
    if ((ts.isParameter(node) || ts.isBindingElement(node)) && node.initializer) {
      const inParams = ts.isParameter(node) || ts.findAncestor(node, ts.isParameter);
      const key = ts.isBindingElement(node) ? (node.propertyName ?? node.name) : node.name;
      const name = key && (ts.isIdentifier(key) || ts.isStringLiteral(key)) ? key.text : '';
      const s = literal(node.initializer);
      if (inParams && COPY_PARAM.test(name) && s !== null && isCopy(s))
        add(node, `${name} = '${s}'`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * Every finding in one file. `path` is repo-relative (it decides the overlay
 * exemption and the parser), `text` is the file.
 */
export function checkSource(path, text) {
  const findings = [];
  const add = (rule, line, what) => findings.push({ path, line, rule, text: what });
  const isCode = /\.[cm]?[jt]sx?$/.test(path);
  const isCss = path.endsWith('.css');

  // raw-palette: the guard's own shape — every line that does not start a comment.
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
    for (const m of line.matchAll(RAW_COLOR_SCALES)) add('raw-palette', i + 1, m[0]);
  });

  if (isCode) {
    const { sf, comments, strings } = parse(path, text);

    for (const s of strings) {
      const raw = s.getText(sf);
      for (const m of raw.matchAll(BRAND_TEXT)) {
        add('brand-text', lineOf(text, s.getStart(sf) + m.index), m[0]);
      }
    }

    const prose = [
      ...comments.map((c) => ({ start: c.start, raw: c.text })),
      ...strings.map((s) => ({ start: s.getStart(sf), raw: s.getText(sf) })),
    ];
    for (const { start, raw } of prose) {
      for (const m of raw.replace(NOT_VOCAB, (w) => ' '.repeat(w.length)).matchAll(VOCAB)) {
        add('vocabulary', lineOf(text, start + m.index), m[0]);
      }
    }

    for (const f of englishCopy(sf)) add('english-copy', f.line, f.text);

    const code = withoutComments(text).split('\n');
    const codeText = code.join('\n');
    if (!OVERLAY_PRIMITIVES.has(path)) {
      code.forEach((line, i) => {
        if (CLICK_AWAY.test(line)) add('hand-rolled-menu', i + 1, 'fixed inset-0 click-away layer');
        if (FLOATING_MENU.test(line))
          add('hand-rolled-menu', i + 1, 'absolute top-full/bottom-full menu');
      });
      const state = MENU_STATE.exec(codeText);
      if (state) add('hand-rolled-menu', lineOf(codeText, state.index), state[0]);
    }

    // native-select reads code with strings blanked too: `<select>` in prose is not an element.
    code.forEach((line, i) => {
      const bare = line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
      if (NATIVE_SELECT.test(bare)) add('native-select', i + 1, '<select');
    });

    for (const re of [INLINE_MOTION, INFINITE]) {
      for (const m of text.matchAll(re)) add('motion', lineOf(text, m.index), m[0].trim());
    }
  } else {
    const body = isCss ? text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')) : text;
    if (isCss)
      for (const m of body.matchAll(BRAND_TEXT)) add('brand-text', lineOf(text, m.index), m[0]);
    for (const m of text.replace(NOT_VOCAB, (w) => ' '.repeat(w.length)).matchAll(VOCAB)) {
      add('vocabulary', lineOf(text, m.index), m[0]);
    }
  }

  return findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}
