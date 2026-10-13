import { readFileSync, globSync } from 'node:fs';

/**
 * A SETTING NOTHING READS IS A SETTING THAT LIES.
 *
 * `src/env.ts` is where an operator learns what this app can be told. A
 * variable declared there that no code reads looks like a knob and does
 * nothing: set it in production and the app behaves exactly as before, with
 * no error to say so.
 *
 * That happened (#280). `ANTHROPIC_MODEL` was declared with a default, while
 * the moderation classifier used a constant, so setting it changed nothing.
 * Looking further found 41 such variables, all carried over from
 * inflect-compliance: an AI risk assistant, S3 and ClamAV, a read replica,
 * Upstash, vendor monitoring, NVD sync, pipelock receipts. None of those
 * features exists here.
 *
 * So every variable declared in env.ts must be named somewhere else the app,
 * its scripts, its deployment or its tests can read it. Docs don't count: a
 * runbook that mentions a variable doesn't make it do anything.
 */

const ENV_FILE = 'src/env.ts';

const READERS = [
  ...globSync('src/**/*.{ts,tsx,js,mjs}'),
  ...globSync('scripts/**/*.{ts,mjs,js,sh}'),
  ...globSync('tests/**/*.{ts,tsx}'),
  ...globSync('prisma/**/*.{ts,sql}'),
  ...globSync('deploy/**/*'),
  ...globSync('.github/**/*.{yml,yaml}'),
  ...globSync('*.{ts,mjs,js,json,yml,yaml}'),
  'Dockerfile',
].filter(
  (f) =>
    f !== ENV_FILE &&
    f !== 'tests/guardrails/env-vars-are-read.test.ts' &&
    f !== 'package-lock.json',
);

/** `    NAME: z…` at the schema's indentation: one declared variable per match. */
function declared(): string[] {
  const src = readFileSync(ENV_FILE, 'utf8');
  return [...new Set([...src.matchAll(/^ {4}([A-Z][A-Z0-9_]+):\s*z\b/gm)].map((m) => m[1]))];
}

describe('every variable declared in src/env.ts is read somewhere (#280)', () => {
  const corpus = READERS.map((f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  }).join('\n');

  it('finds the declarations at all', () => {
    expect(declared().length).toBeGreaterThan(30);
  });

  it('has no declared variable that nothing reads', () => {
    const unread = declared().filter((name) => !new RegExp(`\\b${name}\\b`).test(corpus));
    expect(unread).toEqual([]);
  });
});
