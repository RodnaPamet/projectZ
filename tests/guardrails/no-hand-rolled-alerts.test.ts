import { globSync, readFileSync } from 'node:fs';

import ts from 'typescript';

import { readAllRows } from '../../scripts/ui-sync/manifest.mjs';
import { treeFiles } from '../helpers/scan-floor';

/**
 * AN ERROR IS AN <InlineNotice variant="error">, NOT A HAND-ROLLED role="alert" (T29).
 *
 * ═══ WHY ═══
 *
 * `role="alert"` is an assertive live region: a screen reader interrupts
 * whatever it is reading to announce it. The vendored primitives own that
 * contract and its look in one place: InlineNotice (error variant), FormError
 * and ErrorState, plus the error hint Input and Textarea render under a
 * field. A hand-rolled `<p role="alert" className="text-content-error">`
 * re-decides all of it per page: no icon, no tinted surface, no border, its
 * own spacing, and (the part nobody sees in review) whether it is announced
 * at all, since the role has to be on the node when its text changes.
 *
 * Before this guard: three, in the moderation queue's two error lines and the
 * invitation's wrong-account refusal. T27 had already moved login's. All
 * three are InlineNotices now, so the allow-list below holds only the
 * vendored primitives themselves.
 *
 * ═══ WHAT COUNTS ═══
 *
 * The role in any form the AST can see: a JSX attribute (`role="alert"`,
 * `role={'alert'}`, `role={x ? 'alert' : 'status'}`), an object property
 * (`role: 'alert'`, how InlineNotice's variant table and a spread of props
 * carry it), and `setAttribute('role', 'alert')`. Prose about the role, in a
 * comment, is not a usage.
 */

/** The primitives that may render the role, each a vendored copy. */
const PRIMITIVES = [
  'src/components/ui/inline-notice.tsx',
  'src/components/ui/form-error.tsx',
  'src/components/ui/error-state.tsx',
  // A field's own error hint, under the input it describes.
  'src/components/ui/input.tsx',
  'src/components/ui/textarea.tsx',
];

const SOURCE = globSync('src/**/*.{ts,tsx}')
  .map(String)
  .filter((f) => !/\.test\.tsx?$/.test(f) && !/(?:^|\/)__tests__\//.test(f))
  .sort();

function scriptKind(file: string): ts.ScriptKind {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** String literals an expression can evaluate to: `'a'`, `c ? 'a' : 'b'`, `'a' as const`. */
function literals(node: ts.Node | undefined): string[] {
  if (!node) return [];
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isJsxExpression(node)) return literals(node.expression);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return literals(node.expression);
  if (ts.isConditionalExpression(node))
    return [...literals(node.whenTrue), ...literals(node.whenFalse)];
  if (ts.isBinaryExpression(node)) return [...literals(node.left), ...literals(node.right)];
  return [];
}

/** The lines of `src` that set role="alert". */
function alertRoles(file: string, src: string): number[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKind(file));
  const lines: number[] = [];
  const hit = (n: ts.Node) => lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
  const visit = (n: ts.Node): void => {
    if (
      ts.isJsxAttribute(n) &&
      n.name.getText(sf) === 'role' &&
      literals(n.initializer).includes('alert')
    )
      hit(n);
    if (
      ts.isPropertyAssignment(n) &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
      n.name.text === 'role' &&
      literals(n.initializer).includes('alert')
    )
      hit(n);
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'setAttribute' &&
      literals(n.arguments[0]).includes('role') &&
      literals(n.arguments[1]).includes('alert')
    )
      hit(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

describe('the scan is not vacuous', () => {
  it('reads the whole tree, and sees the primitives that own the role', () => {
    expect(SOURCE).toEqual(
      treeFiles(['src'], /\.tsx?$/).filter(
        (f) => !/\.test\.tsx?$/.test(f) && !/(?:^|\/)__tests__\//.test(f),
      ),
    );
    // Each allowed primitive really renders it (a stale entry would let a
    // rename slip through), and each is a vendored copy, not playerz's code.
    const vendored = new Set(
      (readAllRows('.') as Array<{ path: string; status: string }>)
        .filter((r) => r.status === 'vendored')
        .map((r) => r.path),
    );
    for (const f of PRIMITIVES) {
      expect(alertRoles(f, readFileSync(f, 'utf8')).length).toBeGreaterThan(0);
      expect(vendored).toContain(f);
    }
  });
});

describe('role="alert" only inside the primitives', () => {
  it('has no hand-rolled alert anywhere else in src/', () => {
    const bad = SOURCE.filter((f) => !PRIMITIVES.includes(f)).flatMap((f) =>
      alertRoles(f, readFileSync(f, 'utf8')).map((l) => `  ${f}:${l}`),
    );
    if (bad.length > 0) {
      throw new Error(
        `Hand-rolled role="alert":\n\n${bad.join('\n')}\n\n` +
          `Use <InlineNotice variant="error"> (an error under a form or a card), or\n` +
          `<ErrorState> (a pane that failed to load), or a field's own error prop\n` +
          `(<Input error>, <FormField error>). They carry the role, the tokens, the icon\n` +
          `and the live region, the same everywhere.`,
      );
    }
  });
});

// ── Negative controls ────────────────────────────────────────────────

describe('the rule fires on what it forbids', () => {
  it.each([
    ['a JSX attribute', '<p role="alert">x</p>'],
    ['a braced literal', "<p role={'alert'}>x</p>"],
    ['a conditional', "<div role={bad ? 'alert' : 'status'} />"],
    ['an object property', "const v = { role: 'alert' as const };"],
    ['a quoted key', "const v = { 'role': 'alert' };"],
    ['the DOM API', "el.setAttribute('role', 'alert');"],
  ])('catches %s', (_l, src) => {
    expect(alertRoles('x.tsx', src)).toEqual([1]);
  });

  it.each([
    '<p role="status">x</p>',
    '<InlineNotice variant="error">x</InlineNotice>',
    '// a hand-rolled role="alert" paragraph used to sit here',
    "const s = 'alert';",
    '<div aria-live="polite" />',
  ])('does NOT flag %s', (src) => {
    expect(alertRoles('x.tsx', src)).toEqual([]);
  });
});
