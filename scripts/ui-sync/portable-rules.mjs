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
 *                                             parameter defaults (label = 'Save'),
 *                                             except the props a11y-copy owns
 *   a11y-copy        i18n-no-hardcoded-copy   what a screen reader reads: aria-label,
 *                    (checkSpokenCopy)        ariaLabel and the other ARIA text props,
 *                                             alt, a title it reads; any word in
 *                                             them, a template's words included
 *   vocabulary       the upstream portability rules: compliance nouns and the
 *                    brands Inflect, PwC, METRO and Dub, in comments, strings,
 *                    JSX text and test names (not identifiers, import paths,
 *                    aria-controls, or data-* / test-id values)
 *   hand-rolled-menu no-hand-rolled-menus     `fixed inset-0` outside ui/modal,
 *                                             ui/sheet, ui/popover and test
 *                                             files, and the anchored-menu
 *                                             idioms beside it
 *   native-select    no-native-select         `<select`, also at the end of a line
 *   motion           motion-safety            inline durations, infinite animations
 *   brand-text       no-raw-brand-text        text-brand-NNN, text- + arbitrary var(--brand-<name>)
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

/**
 * i18n-no-hardcoded-copy.test.ts. english-copy leaves aria-label,
 * aria-description, alt and a spoken title to a11y-copy (isSpokenAttr).
 */
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
 * ═══ a11y-copy: WHAT A SCREEN READER READS (inflect #3201) ═══
 *
 * The vendored LocaleSwitcher named its radio group with `ariaLabel="Language"`.
 * english-copy reads the attribute names i18n-no-hardcoded-copy lists, and
 * `ariaLabel` is a camelCase PROP, not the `aria-label` attribute, so the
 * string passed this scan, was copied, and a screen reader said "Language" on
 * every Bulgarian page with the switch (#431, #433).
 *
 * a11y-copy owns the props whose reader is assistive technology:
 *
 *   - ARIA's text properties, as attributes (aria-label, aria-description,
 *     aria-roledescription, aria-valuetext, aria-placeholder and the braille
 *     pair) and as props (ariaLabel, ariaRoleDescription …), with a
 *     component's prefixed variants (closeAriaLabel, incrementAriaLabel) and
 *     the other names components give that text (accessibilityLabel,
 *     srLabel, screenReaderText …). Never aria-labelledby and the other id
 *     and token attributes, and never data-*;
 *   - alt (and imageAlt …);
 *   - title where a screen reader takes it from: on any HTML or SVG element
 *     it is the tooltip and the name or the description; on a component only
 *     when the component is interactive (a Button, a Link, a …Trigger, or one
 *     given onClick or href). Elsewhere a component's `title` is its own prop,
 *     usually a visible heading, and english-copy reads it.
 *
 * It reads them in JSX attributes, in object literals (props spread onto an
 * element, an option handed to a primitive), in parameter defaults and in
 * `setAttribute('aria-label', …)`. Its test is stricter than isCopy, because
 * none of these props takes a key or a token, so every value is spoken: two
 * letters in a row in any script. That flags a single lowercase word
 * (`aria-label="close"`), which isCopy lets through as a likely key, and the
 * words around a template's substitutions (`Remove ${name}`), which
 * english-copy never reads. A template that is only substitutions and
 * punctuation (`${court}, ${time}`) is the caller's text and passes.
 */
const ARIA_TEXT = [
  'label',
  'description',
  'roledescription',
  'valuetext',
  'placeholder',
  'braillelabel',
  'brailleroledescription',
];
/** Read with hyphens dropped and in lower case, so aria-label, ariaLabel and closeAriaLabel match alike. */
const SPOKEN_PROP = new RegExp(
  `(?:aria(?:${ARIA_TEXT.join('|')})|accessib(?:ility|le)(?:label|name)|a11ylabel|srlabel|srtext|screenreader(?:label|text))$`,
);
/** NOT_COPY without its last alternative: a lowercase word is spoken too. */
const NOT_SPOKEN =
  /^(playerz\.bg|playerz|GNU GPL v3|MIT|Apache|ISO \d+|[A-Z]{2,6}|[\d\s.,:/%+-]+)$/;
/** A template substitution, as spokenValues() writes it. */
const SUBSTITUTION = '${…}';
/** Components that are controls: their `title` is a tooltip on something a user operates. */
const INTERACTIVE_COMPONENT =
  /(?:Button|Link|Trigger|Toggle|Tab|MenuItem|Checkbox|Radio|Switch|Input|Select|Combobox|Textarea|Option|Slider|Stepper|Picker|Chip)$/;
const ACTION_PROPS = new Set(['onClick', 'onPress', 'onSelect', 'href']);

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
/**
 * Technical uses blanked before matching: the word is the platform's or the
 * test harness's, not the product's. ARIA's own attribute, and a `data-*`
 * attribute written out inside text (a `[data-testid="pagination-controls"]`
 * selector, an HTML fixture). #300.
 */
const NOT_VOCAB = /aria-controls|(?<![\w-])data-[\w-]+\s*=\s*(["'])(?:(?!\1)[^\n])*\1/gi;
const blankTechnical = (raw) => raw.replace(NOT_VOCAB, (w) => ' '.repeat(w.length));

/**
 * A string that is the VALUE of a `data-*` attribute — `data-testid="…"`,
 * `{ 'data-state': … }` — or the test id a `…ByTestId('…')` query looks up.
 * Test and automation hooks, never shown to a user, so `pagination-controls`
 * there is a widget name, not the compliance noun (#300). Only the value
 * position counts: the same word in a className, a route or JSX text is
 * still read.
 */
function isDataAttrValue(node) {
  let child = node;
  let p = node.parent;
  while (
    p &&
    (ts.isJsxExpression(p) ||
      ts.isParenthesizedExpression(p) ||
      ts.isTemplateExpression(p) ||
      ts.isTemplateSpan(p) ||
      (ts.isConditionalExpression(p) && p.condition !== child))
  ) {
    child = p;
    p = p.parent;
  }
  if (!p) return false;
  if (ts.isJsxAttribute(p)) return /^data-/.test(p.name.getText());
  if (ts.isPropertyAssignment(p) && p.initializer === child) {
    const key = p.name;
    return (ts.isStringLiteral(key) || ts.isIdentifier(key)) && /^data-/.test(key.text);
  }
  if (ts.isCallExpression(p) && p.arguments[0] === child) {
    const callee = ts.isPropertyAccessExpression(p.expression) ? p.expression.name : p.expression;
    return ts.isIdentifier(callee) && /ByTestId$/.test(callee.text);
  }
  return false;
}

/**
 * A test file (tests/**, *.test.*). A ratchet that counts bespoke overlays has
 * to quote `fixed inset-0` to count it, so the click-away rule skips tests
 * (#300); every other rule still reads them.
 */
const isTestFile = (path) => /(?:^|\/)tests\//.test(path) || /\.test\.[^/]+$/.test(path);

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

/** A prop or attribute whose value assistive technology reads (a11y-copy). */
function isSpokenName(name) {
  if (!name || name.startsWith('data-')) return false;
  if (name === 'alt' || /[a-z]Alt$/.test(name)) return true;
  return SPOKEN_PROP.test(name.replace(/-/g, '').toLowerCase());
}

/** Does the element this JSX attribute sits on give its `title` to a screen reader? */
function titleIsSpoken(attr, sf) {
  const element = attr.parent?.parent; // JsxAttributes, then the opening or self-closing element
  if (!element?.tagName) return false;
  const tag = element.tagName.getText(sf).split('.').pop();
  if (/^[a-z]/.test(tag)) return true; // div, button, svg, motion.button: an HTML or SVG element
  if (INTERACTIVE_COMPONENT.test(tag)) return true;
  return element.attributes.properties.some(
    (p) => ts.isJsxAttribute(p) && ACTION_PROPS.has(p.name.getText(sf)),
  );
}

/** The JSX attributes a11y-copy reads, which english-copy therefore does not. */
function isSpokenAttr(attr, sf) {
  const name = attr.name.getText(sf);
  return isSpokenName(name) || (name === 'title' && titleIsSpoken(attr, sf));
}

/** The operators whose operands both become the value: `label ?? 'x'`, `a || 'x'`, `'x ' + n`. */
const EITHER_SIDE = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.PlusToken,
]);

/**
 * The text a value resolves to from the file itself: a literal, a template's
 * fixed words with each substitution as SUBSTITUTION, both arms of a
 * ternary, both sides of `??`, `||` and `+`, and the right of `&&`. A
 * condition (`kind === 'close'`) is never the value.
 */
function spokenValues(n) {
  if (!n) return [];
  if (
    ts.isJsxExpression(n) ||
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n)
  ) {
    return spokenValues(n.expression);
  }
  if (ts.isConditionalExpression(n)) {
    return [...spokenValues(n.whenTrue), ...spokenValues(n.whenFalse)];
  }
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    if (EITHER_SIDE.has(op)) return [...spokenValues(n.left), ...spokenValues(n.right)];
    return op === ts.SyntaxKind.AmpersandAmpersandToken ? spokenValues(n.right) : [];
  }
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.text];
  if (ts.isTemplateExpression(n)) {
    return [n.head.text + n.templateSpans.map((s) => SUBSTITUTION + s.literal.text).join('')];
  }
  return [];
}

/** Words a screen reader would say: two letters in a row, outside the substitutions and the brand. */
function isSpoken(value) {
  if (NOT_SPOKEN.test(value.trim())) return false;
  const words = value
    .split(SUBSTITUTION)
    .join(' ')
    .replace(/playerz(?:\.bg)?/gi, ' ');
  return /\p{L}{2,}/u.test(words);
}

function a11yCopy(sf) {
  const found = [];
  const report = (node, value, show) => {
    for (const v of spokenValues(value)) {
      if (!isSpoken(v)) continue;
      found.push({
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        text: show(v),
      });
    }
  };

  const visit = (node) => {
    if (ts.isJsxAttribute(node) && isSpokenAttr(node, sf)) {
      const name = node.name.getText(sf);
      report(node, node.initializer, (v) => `${name}="${v}"`);
    }
    if (ts.isPropertyAssignment(node)) {
      const key = node.name;
      const name = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : '';
      if (isSpokenName(name)) report(node, node.initializer, (v) => `${name}: '${v}'`);
    }
    if ((ts.isParameter(node) || ts.isBindingElement(node)) && node.initializer) {
      const inParams = ts.isParameter(node) || ts.findAncestor(node, ts.isParameter);
      const key = ts.isBindingElement(node) ? (node.propertyName ?? node.name) : node.name;
      const name = key && (ts.isIdentifier(key) || ts.isStringLiteral(key)) ? key.text : '';
      if (inParams && isSpokenName(name)) {
        report(node, node.initializer, (v) => `${name} = '${v}'`);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setAttribute'
    ) {
      const [attr, value] = node.arguments;
      if (attr && ts.isStringLiteral(attr) && (isSpokenName(attr.text) || attr.text === 'title')) {
        report(node, value, (v) => `setAttribute('${attr.text}', '${v}')`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
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
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      COPY_ATTRS.has(node.name.text) &&
      !isSpokenAttr(node, sf)
    ) {
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
      if (inParams && COPY_PARAM.test(name) && !isSpokenName(name) && s !== null && isCopy(s))
        add(node, `${name} = '${s}'`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * a11y-copy alone, over one code file: what i18n-no-hardcoded-copy runs over
 * playerz's own components, whose attribute list has the same blind spot.
 */
export function checkSpokenCopy(path, text) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  return a11yCopy(sf).map((f) => ({ path, line: f.line, rule: 'a11y-copy', text: f.text }));
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
      ...strings
        .filter((s) => !isDataAttrValue(s))
        .map((s) => ({ start: s.getStart(sf), raw: s.getText(sf) })),
    ];
    for (const { start, raw } of prose) {
      for (const m of blankTechnical(raw).matchAll(VOCAB)) {
        add('vocabulary', lineOf(text, start + m.index), m[0]);
      }
    }

    for (const f of englishCopy(sf)) add('english-copy', f.line, f.text);
    for (const f of a11yCopy(sf)) add('a11y-copy', f.line, f.text);

    const code = withoutComments(text).split('\n');
    const codeText = code.join('\n');
    if (!OVERLAY_PRIMITIVES.has(path)) {
      code.forEach((line, i) => {
        if (CLICK_AWAY.test(line) && !isTestFile(path))
          add('hand-rolled-menu', i + 1, 'fixed inset-0 click-away layer');
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
    for (const m of blankTechnical(text).matchAll(VOCAB)) {
      add('vocabulary', lineOf(text, m.index), m[0]);
    }
  }

  return findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/**
 * Every finding in a set of manifest rows. `read(row)` returns the file's text,
 * or null to skip the row (a file that is not there). Findings carry the row's
 * playerz path and its status.
 *
 * The guardrail runs this over every 'vendored' row, so a copy that escaped
 * the per-PR check (T17 copied only its own files; session-expired-notice.tsx,
 * vendored earlier, still said "evidence upload") fails CI wherever it sits.
 * 'pending' rows are inflect's to clean up (#3047/#3048); check-portable.mjs
 * --manifest pending lists them without failing.
 */
export function checkRows(rows, read) {
  return rows.flatMap((row) => {
    const text = read(row);
    if (text === null) return [];
    return checkSource(row.path, text).map((f) => ({ ...f, status: row.status }));
  });
}
