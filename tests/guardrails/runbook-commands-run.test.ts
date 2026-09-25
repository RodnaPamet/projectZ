import { readFileSync } from 'node:fs';

/**
 * THE RUNBOOK'S COMMANDS MUST ACTUALLY RUN.
 *
 * `docs/platform-admin-runbook.md` is written for somebody at 03:00 whose
 * platform grant has just lapsed mid-incident. Every instruction in it is one
 * they will follow without thinking, because thinking is what they have no
 * capacity for at that moment.
 *
 * The first version told them to run `tsx scripts/grant-platform-admin.ts`.
 * That fails with `command not found`: `tsx` is a local devDependency, not on
 * PATH and not installed globally. Verified by running it.
 *
 * A break-glass document whose commands do not execute is worse than no
 * document, because it consumes the one resource the reader is shortest of.
 * This asserts the shape that works.
 */

const RUNBOOK = 'docs/platform-admin-runbook.md';

describe('the platform-admin runbook is runnable', () => {
  const src = readFileSync(RUNBOOK, 'utf8');

  it('the scan found the runbook', () => {
    // Without this, a renamed file makes every assertion below vacuous.
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain('grant-platform-admin');
  });

  it('invokes the CLI through a binary that exists on PATH', () => {
    // `tsx …` and `./scripts/… ` both assume something this repo does not
    // install. `npm run …` and `npx tsx …` both work from a clean checkout.
    const unrunnable = src
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /^(tsx|\.\/scripts\/|node scripts\/)/.test(line));

    expect(unrunnable.map((u) => `${RUNBOOK}:${u.n}: ${u.line}`)).toEqual([]);
  });

  it('passes flags through with the required --', () => {
    // `npm run x --user alice` sends --user to NPM, not to the script, and the
    // script then fails on a missing required flag. The `--` separator is the
    // whole difference and it is easy to drop when copying a line.
    const npmInvocations = src
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => line.startsWith('npm run grant:platform-admin'));

    expect(npmInvocations.length).toBeGreaterThan(0);
    for (const { line, n } of npmInvocations) {
      expect(`${n}: ${line}`).toMatch(/npm run grant:platform-admin --(\s|$)/);
    }
  });

  it('names an npm script that exists', () => {
    // The command could be perfectly formed and still fail because nobody added
    // the script — which is how this document got written in the first place.
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;

    expect(scripts['grant:platform-admin']).toBeDefined();
    expect(scripts['grant:platform-admin']).toContain('scripts/grant-platform-admin.ts');
  });

  // ── Negative control ───────────────────────────────────────────────
  it('the detector fires on the form that does not run', () => {
    const unrunnable = /^(tsx|\.\/scripts\/|node scripts\/)/;

    expect(unrunnable.test('tsx scripts/grant-platform-admin.ts --user a')).toBe(true);
    expect(unrunnable.test('./scripts/grant-platform-admin.ts')).toBe(true);
    expect(unrunnable.test('npm run grant:platform-admin -- --user a')).toBe(false);
    expect(unrunnable.test('npx tsx scripts/grant-platform-admin.ts')).toBe(false);
  });
});
