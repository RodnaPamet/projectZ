import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/**
 * EVERY WRITE INTO A MESSAGE BODY IS SANITISED.
 *
 * Chat is the highest-risk surface in the product: text one user writes and
 * another user's BROWSER renders.
 *
 * Sanitising at render time only means every future renderer has to remember —
 * and the one that forgets is a stored XSS that has been sitting in the
 * database since the day it was written. (P06 found exactly such a bug in the
 * ported sanitiser: a double-unescape that RESURRECTED the `<script>` tag it
 * had just stripped. `ChatMessage.body` is the field it would have resurrected
 * it into.)
 *
 * So the body is cleaned on the WAY IN, and this fails the build on a write
 * path that skips it.
 */
const WRITE_TO_BODY = /\bchatMessage\.(?:create|createMany|update|updateMany)\s*\(/;

const SOURCES = ['src/app-layer/**/*.ts', 'src/app/**/*.ts', 'src/lib/**/*.ts'];

/** Index just past the paren closing the first `(`. */
function callEnd(s: string): number {
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

describe('message write sanitisation', () => {
  const files = SOURCES.flatMap((p) => globSync(p).map((f) => f.toString()));

  it('the scan reaches the app layer', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('every write into a message body routes through sanitizePlainText', () => {
    const hits: Array<{ file: string; line: number }> = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');

      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*')) return;
        if (!WRITE_TO_BODY.test(line)) return;

        const window = lines.slice(i, i + 30).join('\n');
        const call = window.slice(0, callEnd(window));

        // The call must not set `body` from something unsanitised. Either the
        // file sanitises (and assigns the cleaned value), or the write does not
        // touch `body` at all (e.g. a tombstone setting body: '').
        const touchesBody = /\bbody\s*:/.test(call);
        if (!touchesBody) return;

        const setsEmpty = /\bbody\s*:\s*''/.test(call);
        if (setsEmpty) return; // a tombstone

        const fileSanitises = /sanitizePlainText\s*\(/.test(src);
        if (fileSanitises) return;

        hits.push({ file, line: i + 1 });
      });
    }

    if (hits.length > 0) {
      const report = hits.map((h) => `  ${h.file}:${h.line}`).join('\n');
      throw new Error(
        `${hits.length} message-body write(s) with no sanitisation:\n${report}\n\n` +
          `Chat is text ONE user writes and ANOTHER user's browser renders. Sanitising only\n` +
          `at render means every future renderer has to remember, and the one that forgets is\n` +
          `a stored XSS that has been in the database since the day it was written.\n\n` +
          `Fix: run the body through sanitizePlainText() before persisting.`,
      );
    }

    expect(hits).toHaveLength(0);
  });
});
