import { readFileSync, existsSync, globSync } from 'node:fs';

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
 * A JSON body paired with a 4xx/5xx status. Deliberately narrow: it matches
 * the literal `{ error: ... }` bodies this rule is about and ignores
 * everything else, because a guardrail that tries to understand all of
 * JavaScript is a guardrail that fails on a refactor.
 */
const ERROR_BODY = /\{\s*error:\s*(['"`]|\{)/g;

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
    const src = code(readFileSync(file, 'utf8'));
    const violations: string[] = [];

    for (const match of src.matchAll(ERROR_BODY)) {
      // Group 1 is `{` for the canonical nested object, or a quote character
      // for the flat `{ error: 'forbidden' }` shape this rule forbids.
      if (match[1] !== '{') {
        const line = src.slice(0, match.index).split('\n').length;
        violations.push(`${file}:${line}  ${src.slice(match.index, match.index + 60).trim()}`);
      }
    }

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
