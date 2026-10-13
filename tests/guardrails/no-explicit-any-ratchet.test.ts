import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';

/**
 * `any` RATCHET — baseline zero, and it may only ever go down.
 *
 * One `any` in a security path is worth more than a hundred elsewhere. An
 * `any` on a permission check, a tenant id, or a JWT claim silently disables
 * every type guarantee downstream of it — and the code still compiles, still
 * passes review, and still looks exactly like the safe version.
 *
 * The baseline is 0. A number that can only fall.
 */
const BASELINE = 0;

/** Security-critical paths where an `any` is a build failure, not a warning. */
const CRITICAL = [
  'src/lib/auth/**/*.ts',
  'src/lib/security/**/*.ts',
  'src/app-layer/policies/**/*.ts',
  'src/proxy.ts',
];

const ANY_RE = /:\s*any\b|<any>|as\s+any\b|\bany\[\]/;

function scan(patterns: string[]) {
  const hits: Array<{ file: string; line: number; snippet: string }> = [];

  for (const p of patterns) {
    for (const f of globSync(p)) {
      const file = f.toString();
      if (file.endsWith('.d.ts')) continue;

      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
          // `unknown` is the correct escape hatch and is not an `any`.
          if (!ANY_RE.test(line)) return;
          hits.push({ file, line: i + 1, snippet: t.slice(0, 80) });
        });
    }
  }

  return hits;
}

describe('no-explicit-any ratchet', () => {
  it('the scan reaches the security-critical paths', () => {
    expect(globSync('src/lib/security/**/*.ts').length).toBeGreaterThan(0);
  });

  it(`security-critical code has at most ${BASELINE} explicit any`, () => {
    const hits = scan(CRITICAL);

    if (hits.length > BASELINE) {
      const report = hits.map((h) => `  ${h.file}:${h.line}  ${h.snippet}`).join('\n');
      throw new Error(
        `${hits.length} explicit \`any\` in security-critical code (baseline ${BASELINE}):\n` +
          `${report}\n\n` +
          `An \`any\` on a permission check, a tenant id, or a JWT claim silently disables\n` +
          `every type guarantee downstream — and still compiles, still passes review, and\n` +
          `still looks exactly like the safe version.\n\n` +
          `Use \`unknown\` and narrow it.`,
      );
    }

    expect(hits.length).toBeLessThanOrEqual(BASELINE);
  });
});
