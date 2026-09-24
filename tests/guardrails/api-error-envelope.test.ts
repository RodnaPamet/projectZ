import { readFileSync, existsSync, globSync } from 'node:fs';

import ts from 'typescript';

/**
 * ONE ERROR SHAPE, EVERYWHERE.
 *
 * `ApiErrorResponse` (src/lib/errors/types.ts) is the contract:
 *
 *     { error: { code, message, requestId?, details? } }
 *
 * `withApiErrorHandling` produces it for anything that throws. But not every
 * error response goes through the wrapper — the Edge middleware cannot import
 * it, and a route can hand-write a `NextResponse.json(..., { status: 4xx })`
 * without throwing anything at all. Those are the ones that drift.
 *
 * ═══ WHY A SECOND SHAPE IS WORSE THAN AN UGLY ONE ═══
 *
 * `{"error":"forbidden"}` is perfectly readable, and a browser fetch() does
 * not care. A NATIVE client does: it decodes ONE error type, so a String
 * where a struct belongs is not a cosmetic inconsistency, it is a decode
 * failure. A clean 403 the app should show as "you don't have access"
 * surfaces as an unrecognisable crash instead — in a binary that takes a week
 * to fix and that some users never update.
 *
 * This is cheap to hold now and expensive to retrofit once clients exist,
 * which is the only reason it is worth a ratchet before the API is written.
 */

/** Strip comments, so this file's own prose does not trip its own rules. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//');
      return i === -1 ? l : l.slice(0, i);
    })
    .join('\n');
}

/**
 * Deliberate carve-outs. Each one names WHY, because an exemption list with
 * no reasons becomes the place violations go to be forgotten.
 *
 * `api-version.ts` already recognises this category: routes whose consumer is
 * not our client and whose contract is therefore not ours to set.
 */
const EXEMPT: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'src/app/api/webhooks/stripe/route.ts',
    why:
      'External receiver. The only caller is Stripe, which reads the STATUS ' +
      'and ignores the body; no client of ours ever decodes this response. ' +
      'Stripe owns this contract, so the canonical envelope does not apply.',
  },
];

const EXEMPT_FILES = new Set(EXEMPT.map((e) => e.file));

const SOURCES = [
  'src/middleware.ts',
  ...globSync('src/app/api/**/route.ts').map((f) => f.toString()),
].filter((f) => !EXEMPT_FILES.has(f));

/**
 * Every `error` property handed to a `.json(...)` response, and whether its
 * value is a struct.
 *
 * ═══ WHY AN AST AND NOT A REGEX ═══
 *
 * This was `/\{\s*error:\s*(['"`]|\{)/g`, which required `error:` to be the
 * FIRST key after the brace and its value to be a literal quote or brace. So
 * it saw none of:
 *
 *     NextResponse.json({ error: msg }, { status: 403 })          // a variable
 *     NextResponse.json({ ok: false, error: 'forbidden' }, ...)   // not first
 *     NextResponse.json({ error }, { status: 403 })               // shorthand
 *
 * All three serialise to a top-level `"error"` holding a String — the exact
 * `{"error":"forbidden"}` shape the docblock above quotes as the thing that
 * breaks a native client.
 *
 * It was also blind in the other direction: matching raw text meant
 * `const shape = { error: 'x' }` counted as a response, and it could not see
 * the ternary at src/middleware.ts:70 — the one file the second describe block
 * below exists to pin. Inspecting only `.json()` arguments fixes both.
 *
 * KNOWN GAP, stated rather than papered over: a body built into a variable and
 * then passed — `const body = { error: msg }; return NextResponse.json(body)`
 * — still escapes. Resolving locals is where a guardrail starts trying to
 * understand all of JavaScript.
 *
 * ═══ WHY STATUS IS NOT PART OF THE RULE ═══
 *
 * The old docblock claimed to match "a JSON body paired with a 4xx/5xx
 * status". It never read the status argument at all — and it must not start.
 * src/app/api/v1/realtime/subscribe/route.ts returns the canonical envelope at
 * status 200 in four places, because Centrifugo's proxy protocol demands a
 * 200. Gating on 4xx/5xx would silently stop policing that entire file.
 */
function envelopeViolations(file: string, src: string): string[] {
  const sourceFile = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];

  const lineOf = (node: ts.Node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  /** A struct with both `code` and `message` — the canonical envelope. */
  const isEnvelopeObject = (node: ts.Node): boolean => {
    if (!ts.isObjectLiteralExpression(node)) return false;
    const keys = node.properties
      .map((prop) => (prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null))
      .filter(Boolean);
    return keys.includes('code') && keys.includes('message');
  };

  /** Every branch of a ternary or `??`/`||` chain must be an envelope. */
  const isEnvelope = (node: ts.Node): boolean => {
    if (ts.isParenthesizedExpression(node)) return isEnvelope(node.expression);
    if (ts.isConditionalExpression(node)) {
      return isEnvelope(node.whenTrue) && isEnvelope(node.whenFalse);
    }
    if (ts.isBinaryExpression(node)) {
      return isEnvelope(node.left) && isEnvelope(node.right);
    }
    return isEnvelopeObject(node);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'json' &&
      node.arguments.length > 0
    ) {
      const body = node.arguments[0];

      if (ts.isObjectLiteralExpression(body)) {
        for (const prop of body.properties) {
          const named =
            prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
              ? prop.name.text
              : null;
          if (named !== 'error') continue;

          // `{ error }` — a shorthand carrying whatever that variable holds.
          if (ts.isShorthandPropertyAssignment(prop)) {
            violations.push(`${file}:${lineOf(prop)}  { error }  (shorthand)`);
            continue;
          }

          if (ts.isPropertyAssignment(prop) && !isEnvelope(prop.initializer)) {
            violations.push(
              `${file}:${lineOf(prop)}  ${prop.getText(sourceFile).slice(0, 60).replace(/\s+/g, ' ')}`,
            );
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

describe('every hand-written error response uses the canonical envelope', () => {
  it('the scan found the sources it is meant to police', () => {
    // Without this, a broken glob turns the whole suite green.
    expect(SOURCES.length).toBeGreaterThan(1);
    expect(SOURCES).toContain('src/middleware.ts');
  });

  it('every exemption still points at a file that exists', () => {
    // An exemption for a deleted or renamed file is a hole waiting for
    // somebody to recreate that path — and it would never fail on its own.
    for (const { file } of EXEMPT) {
      expect(existsSync(file)).toBe(true);
    }
  });

  it.each(SOURCES)('%s', (file) => {
    // The RAW source, not `code()`. Stripping comments shifted every reported
    // line number — a violation on line 39 was reported as line 30 — and the
    // AST has no trouble with comments.
    const violations = envelopeViolations(file, readFileSync(file, 'utf8'));

    if (violations.length > 0) {
      throw new Error(
        `Error body is a bare string, not the canonical envelope:\n\n` +
          violations.map((v) => `  ${v}`).join('\n') +
          `\n\nUse { error: { code, message } } — see ApiErrorResponse in ` +
          `src/lib/errors/types.ts.\n\n` +
          `A native client decodes one error type. A String where a struct ` +
          `belongs is a decode failure, not a readable message.`,
      );
    }
  });
});

describe('the middleware copy stays pinned to the original', () => {
  // The Edge runtime cannot import src/lib/errors/types.ts, so middleware.ts
  // hand-writes the envelope. Duplication is the right call there — but only
  // if the copy is held against the original by something.

  it('middleware emits code AND message, the two required fields', () => {
    const src = code(readFileSync('src/middleware.ts', 'utf8'));

    expect(src).toMatch(/\bcode\b/);
    expect(src).toMatch(/\bmessage\b/);
  });

  it('the codes it emits are ones the canonical error classes define', () => {
    // A middleware answering FORBIDDEN while the wrapper answers
    // ACCESS_DENIED for the same condition is the same bug as a different
    // shape, one level down: the client switches on `code`.
    const types = readFileSync('src/lib/errors/types.ts', 'utf8');
    const middleware = code(readFileSync('src/middleware.ts', 'utf8'));

    const emitted = [...middleware.matchAll(/apiError\(\s*\d{3},\s*'([A-Z_]+)'/g)].map(
      (m) => m[1]!,
    );

    expect(emitted.length).toBeGreaterThan(0);

    for (const c of emitted) {
      expect(types).toContain(`'${c}'`);
    }
  });
});
