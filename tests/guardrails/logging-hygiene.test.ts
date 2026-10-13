import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/**
 * LOGGING HYGIENE.
 *
 * `console.log` in a request path is not a style problem. It is:
 *
 *   - unstructured, so it cannot be queried when you actually need it;
 *   - unredacted, so it cheerfully prints the whole object — including the
 *     password field, the Stripe secret, and the player's email — into a log
 *     aggregator that a much wider group of people can read than can read the
 *     database;
 *   - and it never gets removed, because it never fails anything.
 *
 * The most common production data leak is not an attacker. It is a
 * `console.log(user)` that someone added while debugging.
 */
const SOURCES = [
  'src/app/**/*.ts',
  'src/app-layer/**/*.ts',
  'src/lib/**/*.ts',
  'src/proxy.ts',
];

// scripts/ and seeds legitimately print to a terminal a human is watching.
const ALLOW_FILES = /^(scripts\/|src\/app-layer\/jobs\/)/;
const ALLOW_LINE = /guardrail-allow:\s*console/;

describe('logging hygiene', () => {
  it('no console.* in the request path', () => {
    const hits: Array<{ file: string; line: number; snippet: string }> = [];

    for (const pattern of SOURCES) {
      for (const f of globSync(pattern)) {
        const file = f.toString();
        if (ALLOW_FILES.test(file) || file.endsWith('.d.ts')) continue;

        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const t = line.trim();
            if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
            if (!/\bconsole\.(log|info|warn|error|debug)\s*\(/.test(line)) return;
            if (ALLOW_LINE.test(line)) return;
            hits.push({ file, line: i + 1, snippet: t.slice(0, 80) });
          });
      }
    }

    if (hits.length > 0) {
      const report = hits.map((h) => `  ${h.file}:${h.line}  ${h.snippet}`).join('\n');
      throw new Error(
        `${hits.length} console.* call(s) in the request path:\n${report}\n\n` +
          `console.log prints the WHOLE object — password fields, Stripe secrets, player\n` +
          `emails — into a log aggregator readable by far more people than the database is.\n` +
          `And it is never removed, because it never fails anything.\n\n` +
          `Use the structured logger, or annotate: // guardrail-allow: console <reason>`,
      );
    }

    expect(hits).toHaveLength(0);
  });
});
