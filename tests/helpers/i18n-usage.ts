import { globSync, readFileSync } from 'node:fs';

import ts from 'typescript';

/**
 * WHICH CATALOGUE KEYS DOES THE CODE ASK FOR?
 *
 * The scan behind i18n-keys-resolve and i18n-orphan-keys. It reads every
 * source file's AST, finds the translators (`useTranslations('ns')`,
 * `await getTranslations('ns')`, the `{ namespace }` form, and either one
 * inside `await Promise.all([...])`), and records every call made through
 * one, with the namespace the translator was bound to:
 *
 *   t('title')                       literal   ns.title
 *   t(`status.${s}`)                 pattern   ns.status.<one segment>
 *   t(cond ? 'a' : 'b')              literal   ns.a and ns.b
 *   t('a' as never), t.rich('a'), t.has('a'), t.raw('a'), t.markup('a')
 *   t(item.labelKey)                 dynamic   the key is data: an allow-listed
 *                                              family in the orphan guard covers it
 *   translateFor(locale, 'a.b')      literal   a.b (src/lib/i18n/server-messages.ts,
 *                                              no namespace)
 *
 * Translators are resolved by lexical scope, not by name, so two components
 * in one file that both call theirs `t` keep their own namespaces. A call
 * through a translator the scan cannot see bound (a `t` parameter) is not a
 * use; nav-items.ts and combobox/messages.ts take theirs that way, and the
 * orphan guard's families say so.
 */

export type KeyUse =
  | { kind: 'literal'; file: string; line: number; key: string }
  | { kind: 'pattern'; file: string; line: number; source: string; pattern: RegExp }
  | { kind: 'dynamic'; file: string; line: number; namespace: string; text: string };

const TRANSLATOR_FACTORIES = new Set(['useTranslations', 'getTranslations']);
const TRANSLATOR_METHODS = new Set(['rich', 'markup', 'raw', 'has']);

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** `x as never`, `(x)`, `x!`, `x satisfies T` → x. */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node;
  while (
    ts.isAsExpression(n) ||
    ts.isParenthesizedExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isAwaitExpression(n)
  )
    n = n.expression;
  return n;
}

/** The namespace a `useTranslations(...)` / `getTranslations(...)` call binds, or null. */
function translatorNamespace(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  const call = unwrap(node);
  if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return null;
  if (!TRANSLATOR_FACTORIES.has(call.expression.text)) return null;
  const arg = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
  if (!arg) return '';
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (ts.isObjectLiteralExpression(arg)) {
    for (const p of arg.properties) {
      if (
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === 'namespace' &&
        ts.isStringLiteralLike(p.initializer)
      )
        return p.initializer.text;
    }
    return '';
  }
  return null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const join = (ns: string, key: string) => (ns ? `${ns}.${key}` : key);

/** The key arguments an expression can evaluate to, as far as the source says. */
function keysOf(
  arg: ts.Expression,
): Array<{ literal: string } | { pattern: string; source: string } | { dynamic: string }> {
  const n = unwrap(arg);
  if (ts.isStringLiteralLike(n)) return [{ literal: n.text }];
  if (ts.isConditionalExpression(n)) return [...keysOf(n.whenTrue), ...keysOf(n.whenFalse)];
  if (ts.isTemplateExpression(n)) {
    // One substitution stands for one or more key segments' worth of text,
    // never a dot-free gap the catalogue could not hold.
    let re = escape(n.head.text);
    let source = n.head.text;
    for (const span of n.templateSpans) {
      re += '[^.]+(?:\\.[^.]+)*';
      re += escape(span.literal.text);
      source += `\${…}${span.literal.text}`;
    }
    return [{ pattern: re, source }];
  }
  return [{ dynamic: n.getText() }];
}

/** Every catalogue lookup in one file. */
export function keyUsesIn(file: string, src: string): KeyUse[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKind(file));
  const uses: KeyUse[] = [];
  const scopes: Array<Map<string, string>> = [new Map()];

  const lookup = (name: string): string | undefined => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const ns = scopes[i]!.get(name);
      if (ns !== undefined) return ns;
    }
    return undefined;
  };
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const record = (ns: string, arg: ts.Expression | undefined, at: ts.Node) => {
    if (!arg) return;
    for (const k of keysOf(arg)) {
      if ('literal' in k)
        uses.push({ kind: 'literal', file, line: lineOf(at), key: join(ns, k.literal) });
      else if ('pattern' in k)
        uses.push({
          kind: 'pattern',
          file,
          line: lineOf(at),
          source: join(ns, k.source),
          pattern: new RegExp(`^${ns ? `${escape(ns)}\\.` : ''}${k.pattern}$`),
        });
      else uses.push({ kind: 'dynamic', file, line: lineOf(at), namespace: ns, text: k.dynamic });
    }
  };

  const bind = (decl: ts.VariableDeclaration) => {
    const scope = scopes[scopes.length - 1]!;
    if (ts.isIdentifier(decl.name)) {
      const ns = translatorNamespace(decl.initializer);
      if (ns !== null) scope.set(decl.name.text, ns);
      return;
    }
    // const [t, locale] = await Promise.all([getTranslations('x'), getLocale()]);
    if (ts.isArrayBindingPattern(decl.name) && decl.initializer) {
      const init = unwrap(decl.initializer);
      if (
        ts.isCallExpression(init) &&
        init.expression.getText(sf) === 'Promise.all' &&
        init.arguments[0] &&
        ts.isArrayLiteralExpression(init.arguments[0])
      ) {
        const items = init.arguments[0].elements;
        decl.name.elements.forEach((el, i) => {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
            const ns = translatorNamespace(items[i]);
            if (ns !== null) scope.set(el.name.text, ns);
          }
        });
      }
    }
  };

  const opensScope = (n: ts.Node) => ts.isFunctionLike(n) || ts.isBlock(n) || ts.isSourceFile(n);

  const visit = (node: ts.Node): void => {
    const scoped = opensScope(node) && !ts.isSourceFile(node);
    if (scoped) scopes.push(new Map());

    if (ts.isVariableDeclaration(node)) bind(node);

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        const ns = lookup(callee.text);
        if (ns !== undefined) record(ns, node.arguments[0], node);
        else if (callee.text === 'translateFor') record('', node.arguments[1], node);
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        TRANSLATOR_METHODS.has(callee.name.text)
      ) {
        const ns = lookup(callee.expression.text);
        if (ns !== undefined) record(ns, node.arguments[0], node);
      }
    }

    ts.forEachChild(node, visit);
    if (scoped) scopes.pop();
  };
  visit(sf);
  return uses;
}

/** The source the scan reads: all of src/, tests excluded (a test asking for a key is not a use). */
export const SCANNED_SOURCE = (): string[] =>
  globSync('src/**/*.{ts,tsx}')
    .map(String)
    .filter((f) => !/\.test\.tsx?$/.test(f) && !/(?:^|\/)__tests__\//.test(f))
    .sort();

export function allKeyUses(files: string[] = SCANNED_SOURCE()): KeyUse[] {
  return files.flatMap((f) => keyUsesIn(f, readFileSync(f, 'utf8')));
}

type Tree = { [k: string]: string | Tree };

/** Every leaf key of a catalogue, dotted. */
export function catalogueKeys(locale: 'bg' | 'en'): string[] {
  const tree = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as Tree;
  const out: string[] = [];
  const walk = (node: Tree, prefix: string) => {
    for (const [k, v] of Object.entries(node)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') walk(v, key);
      else out.push(key);
    }
  };
  walk(tree, '');
  return out.sort();
}
