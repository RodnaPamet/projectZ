import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

import ts from 'typescript';

/**
 * QUERY SHAPE RATCHET.
 *
 * Two failure modes that pass every functional test and then take the site
 * down for your most successful customer:
 *
 *   D1 — a Prisma read inside a loop. `for (const court of courts) { await
 *        db.booking.findMany(...) }` is an N+1: 12 queries with the seed
 *        data, 4,000 on a real venue page. The code is *correct*. It is just
 *        catastrophically slow, and nothing fails.
 *
 *        "Loop" means every shape that iterates, not just `for`. This was a
 *        line regex anchored at line start:
 *
 *          /^\s*(for\s*\(|while\s*\(|\.forEach\s*\(|\.map\s*\(\s*async)/
 *
 *        Measured over its own globs, the `.forEach(` and `.map(async`
 *        alternatives matched NOTHING in 168 files — all 59 hits were `for (`
 *        or `while (`. They only ever matched a chained `.forEach(` sitting
 *        alone on a line, which nobody writes; the ordinary
 *        `courts.forEach(async (court) => {` never matched. It also missed
 *        `for await (`, and `do { } while ()` entirely.
 *
 *        That mattered: `receiver.map(async (x) => {` appears three times in
 *        production code already. Nothing had escaped only because those
 *        bodies happen to hold writes, which this rule does not police.
 *
 *   D2 — a `findMany` with no `take`. It returns 3 rows in dev and 200,000
 *        in production, then the pod OOMs. Again: correct, and fatal.
 *
 * Neither is caught by types, tests, or review. So they are caught here.
 */

const SOURCES = ['src/app-layer/**/*.ts', 'src/lib/**/*.ts', 'src/app/**/*.ts'];

interface Finding {
  file: string;
  line: number;
  snippet: string;
}

function sourceFiles(): string[] {
  return SOURCES.flatMap((p) => globSync(p).map((f) => f.toString())).filter(
    (f) => !f.endsWith('.d.ts'),
  );
}

const READ_CALL = /\b(?:db|tx|prisma)\.\w+\.(findMany|findFirst|findUnique|count|aggregate)\s*\(/;
const ALLOW = /guardrail-allow:\s*(unbounded|n-plus-one)/;

/** Array methods whose callback body is a loop body in all but name. */
const ITERATORS = new Set([
  'forEach',
  'map',
  'flatMap',
  'filter',
  'some',
  'every',
  'find',
  'findIndex',
  'reduce',
  'reduceRight',
  'sort',
]);

const READ_METHODS = new Set(['findMany', 'findFirst', 'findUnique', 'count', 'aggregate']);
const CLIENTS = new Set(['db', 'tx', 'prisma']);

/** `db.booking.findMany(...)` — a client, a model, then a read. */
function isPrismaRead(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const method = node.expression;
  if (!ts.isPropertyAccessExpression(method)) return false;
  if (!READ_METHODS.has(method.name.text)) return false;

  const model = method.expression;
  if (!ts.isPropertyAccessExpression(model)) return false;

  const client = model.expression;
  return ts.isIdentifier(client) && CLIENTS.has(client.text);
}

/**
 * Is this read exempted by a `guardrail-allow` comment?
 *
 * The read's own line, or ANY line of the comment block directly above it.
 *
 * That second part is not generosity, it is the house style: every
 * `guardrail-allow` in src/ today sits on the lines PRECEDING the code it
 * exempts, and several are multi-line blocks where the marker is three lines
 * up. This rule only ever checked the read's own line, so the escape hatch its
 * own failure message tells you to use did not work the way the codebase
 * writes it — and the only way to discover that is to try it and watch the
 * build stay red.
 */
function isAllowed(lines: string[], readLine: number): boolean {
  if (ALLOW.test(lines[readLine] ?? '')) return true;

  for (let i = readLine - 1; i >= 0; i--) {
    const text = (lines[i] ?? '').trim();
    // Walk up only while we are still inside the comment block.
    if (!text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*')) return false;
    if (ALLOW.test(text)) return true;
  }

  return false;
}

/**
 * Every Prisma read that sits inside something that iterates.
 *
 * An AST walk rather than brace counting. The old line scanner had to track
 * depth by counting `{` and `}` per line, which meant a single-line
 * `items.map((x) => x.id)` — were the regex ever widened to see it — would
 * open a scope it never closed and flag every read in the rest of the file.
 * Nesting, comments, one-liners and brace-less bodies all stop being special
 * cases here.
 */
function readsInLoops(file: string, src: string): Finding[] {
  const sourceFile = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const lines = src.split('\n');
  const findings: Finding[] = [];

  const isLoop = (node: ts.Node): boolean =>
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) || // covers `for await`, via awaitModifier
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node);

  /** The callback of `xs.forEach(...)`, `xs.map(...)`, … */
  const iteratorCallback = (node: ts.Node): ts.Node | null => {
    if (!ts.isCallExpression(node)) return null;
    if (!ts.isPropertyAccessExpression(node.expression)) return null;
    if (!ITERATORS.has(node.expression.name.text)) return null;

    const fn = node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    return fn ?? null;
  };

  const visit = (node: ts.Node, inLoop: boolean): void => {
    if (inLoop && isPrismaRead(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      if (!isAllowed(lines, line)) {
        findings.push({ file, line: line + 1, snippet: (lines[line] ?? '').trim().slice(0, 90) });
      }
    }

    const callback = iteratorCallback(node);
    if (callback) {
      // Only the CALLBACK is a loop body. The receiver — `getCourts().map(…)`
      // — runs once, so it must not inherit the loop context.
      ts.forEachChild(node, (child) => visit(child, inLoop || child === callback));
      return;
    }

    ts.forEachChild(node, (child) => visit(child, inLoop || isLoop(node)));
  };

  visit(sourceFile, false);
  return findings;
}

describe('query shape', () => {
  const files = sourceFiles();

  it('the scan actually found source files', () => {
    // A broken glob would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(20);
  });

  it('D1: no Prisma read inside a loop (N+1)', () => {
    const findings = files.flatMap((file) => readsInLoops(file, readFileSync(file, 'utf8')));

    if (findings.length) {
      const report = findings.map((f) => `  ${f.file}:${f.line}\n    ${f.snippet}`).join('\n');
      throw new Error(
        `${findings.length} Prisma read(s) inside a loop — an N+1 that is fast with seed ` +
          `data and fatal in production:\n${report}\n\n` +
          `Fix: hoist the query out and fetch the whole set once (findMany with an \`in\` ` +
          `filter), or annotate it with \`// guardrail-allow: n-plus-one <reason>\` — on the ` +
          `line itself or anywhere in the comment block directly above it.`,
      );
    }

    expect(findings).toHaveLength(0);
  });

  it('D2: every findMany is bounded by take', () => {
    const findings: Finding[] = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');

      lines.forEach((line, i) => {
        if (!/\.findMany\s*\(/.test(line)) return;
        if (ALLOW.test(line)) return;

        // Look ahead to the end of the call for a `take:`.
        const window = lines.slice(i, i + 25).join('\n');
        const call = window.slice(0, matchingParenEnd(window));

        if (/\btake\s*:/.test(call)) return;
        if (ALLOW.test(call)) return;

        findings.push({ file, line: i + 1, snippet: line.trim().slice(0, 90) });
      });
    }

    if (findings.length) {
      const report = findings.map((f) => `  ${f.file}:${f.line}\n    ${f.snippet}`).join('\n');
      throw new Error(
        `${findings.length} unbounded findMany — returns 3 rows in dev and 200,000 in ` +
          `production:\n${report}\n\n` +
          `Fix: add \`take:\`, or annotate with \`// guardrail-allow: unbounded <reason>\`.`,
      );
    }

    expect(findings).toHaveLength(0);
  });
});

/** Index just past the paren that closes the first `(` in `s`. */
function matchingParenEnd(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return s.length;
}
