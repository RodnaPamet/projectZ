import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE META-RATCHET.
 *
 * Every test downstream of P03 stands on this harness. If a piece of it
 * goes missing — a jest project, an RLS helper, the alt-port test compose
 * stack — the failure mode is not a red test. It is a suite that quietly
 * stops testing: `--selectProjects integration` with no integration
 * project exits 0 and prints "no tests found". A green build that ran
 * nothing is far more dangerous than a red one.
 *
 * So this test asserts the harness still exists and still exports what it
 * advertises. It is the one test that fails loudly when the spine rots.
 */

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('test-infra integrity (meta-ratchet)', () => {
  describe('jest', () => {
    const cfg = read('jest.config.mjs');

    it('defines all four named projects', () => {
      for (const project of ['unit', 'rendered', 'integration', 'guardrails']) {
        expect(cfg).toContain(`displayName: '${project}'`);
      }
    });

    it('runs integration serially (a parallel worker would TRUNCATE another mid-test)', () => {
      expect(cfg).toContain('maxWorkers: 1');
    });

    it('does NOT put coverageThreshold at the top level, where jest silently ignores it', () => {
      // In multi-project mode a top-level `coverageThreshold` is accepted
      // and then never enforced — the run exits 0 no matter how low
      // coverage is. The thresholds must live inside project blocks (and
      // the CI gate passes them via --coverageThreshold, which IS enforced).
      // This asserts the key is not a direct property of the exported config.
      const topLevel = /\n\s{2}coverageThreshold:/.test(cfg);
      expect(topLevel).toBe(false);
      expect(cfg).toContain('coverageThreshold: thresholds');
    });

    it('has a thresholds file the CI gate can read, and the floor never drops', () => {
      const t = JSON.parse(read('jest.thresholds.json'));

      // P12 narrowed the coverage SCOPE (jest.config's collectCoverageFrom)
      // to the authored domain logic, and moved the thresholds to `global`.
      // The scope may be argued about; the FLOOR may not silently fall.
      expect(t.global.lines).toBeGreaterThanOrEqual(70);
      expect(t.global.branches).toBeGreaterThanOrEqual(60);
    });

    it('the coverage scope still covers the code that can actually hurt you', () => {
      // Narrowing the scope is how a coverage gate quietly stops meaning
      // anything: exclude enough and 100% is trivial. The booking, pricing
      // and auth paths must stay inside it.
      const cfg = read('jest.config.mjs');
      for (const required of [
        'src/app-layer/usecases/**/*.ts',
        'src/lib/db/**/*.ts',
        'src/lib/auth/**/*.ts',
        'src/lib/permissions.ts',
      ]) {
        expect(cfg).toContain(required);
      }
    });
  });

  describe('helpers export what they advertise', () => {
    // A dynamic import + shape check, not a filename check: a helper that
    // exists but has lost `seedTenant` is just as broken as a missing file.
    it('tests/helpers/db.ts', async () => {
      const m = await import('../helpers/db');
      for (const fn of [
        'prismaTestClient',
        'resetDatabase',
        'seedTenant',
        'withTenant',
        'tableNames',
      ]) {
        expect(typeof m[fn as keyof typeof m]).toBe('function');
      }
    });

    it('tests/helpers/rls.ts', async () => {
      const m = await import('../helpers/rls');
      for (const fn of ['asAppUser', 'asAppSuperuser', 'expectRlsIsolated']) {
        expect(typeof m[fn as keyof typeof m]).toBe('function');
      }
    });

    it('tests/helpers/make-context.ts', async () => {
      const m = await import('../helpers/make-context');
      expect(typeof m.buildRequestContext).toBe('function');
    });

    it('tests/helpers/msw.ts', async () => {
      const m = await import('../helpers/msw');
      expect(Array.isArray(m.handlers)).toBe(true);
      expect(m.handlers.length).toBeGreaterThan(0);
      expect(typeof m.useMswServer).toBe('function');
    });

    it('tests/helpers/stripe-webhook.ts', async () => {
      const m = await import('../helpers/stripe-webhook');
      expect(typeof m.signStripeWebhook).toBe('function');
      expect(typeof m.paymentIntentSucceeded).toBe('function');
    });
  });

  describe('playwright', () => {
    const cfg = read('playwright.config.ts');

    it('never reuses an existing server', () => {
      // `reuseExistingServer: !CI` let a stale `next start` keep serving an
      // OLD build locally, so CSS/token changes were invisible to the specs
      // — an axe pass and a screenshot baseline were both produced against
      // stale output before this was caught. Never again.
      expect(cfg).toContain('reuseExistingServer: false');
    });

    it('imports the fixtures module', () => {
      expect(existsSync(join(root, 'tests/e2e/fixtures.ts'))).toBe(true);
    });
  });

  describe('the test database is isolated from dev', () => {
    const compose = read('docker-compose.test.yml');

    it('binds Postgres and Redis to ALTERNATE ports', () => {
      // resetDatabase() TRUNCATEs. If the test stack shared the dev stack's
      // ports, a test run would destroy the developer's data.
      expect(compose).toContain('55432:5432');
      expect(compose).toContain('63790:6379');
    });

    it('uses isolated volumes', () => {
      expect(compose).toContain('playerz-test-pgdata');
    });

    it('the harness refuses a non-test DATABASE_URL', async () => {
      const { prismaTestClient } = await import('../helpers/db');
      const saved = process.env.DATABASE_URL;
      try {
        // Simulate a mis-set env pointing at the dev database.
        process.env.DATABASE_URL = 'postgresql://playerz:playerz@localhost:5432/playerz';
        jest.resetModules();
        const fresh = await import('../helpers/db');
        expect(() => fresh.prismaTestClient()).toThrow(/non-test database/i);
      } finally {
        process.env.DATABASE_URL = saved;
        jest.resetModules();
      }
      expect(typeof prismaTestClient).toBe('function');
    });
  });

  describe('CI', () => {
    const ci = read('.github/workflows/ci.yml');

    it('runs every gate the branch protection requires', () => {
      for (const job of [
        'lint:',
        'typecheck:',
        'test:',
        'integration:',
        'build:',
        'e2e:',
        'security:',
        'codeql:',
        'trivy:',
      ]) {
        expect(ci).toContain(`\n  ${job}`);
      }
    });

    it('has a single gate job that fails if any upstream job fails', () => {
      expect(ci).toContain('ci-gate:');
      expect(ci).toContain('failure|cancelled');
    });

    it('creates the RLS roles before running integration tests', () => {
      expect(ci).toContain('CREATE ROLE app_user');
      expect(ci).toContain('BYPASSRLS');
    });
  });
});

describe('the host timezone is pinned by the runner, never from inside a test', () => {
  /**
   * `process.env.TZ = ...` inside a test DOES NOTHING.
   *
   * Node caches the zone on first use and jest's sandboxed `process` never
   * triggers a tzset. Measured: assigning Pacific/Honolulu mid-test left
   * `Intl.DateTimeFormat().resolvedOptions().timeZone` reporting the host's
   * own zone and `getHours()` unchanged.
   *
   * A file that does it LOOKS pinned, which is worse than not trying — a
   * reader has no reason to check, and the suite silently runs under whatever
   * the machine is. One did exactly that, was "pinned" to the side of
   * Greenwich that could not see the bug it was named after, and passed under
   * every mutation of the function it guarded.
   *
   * The zone must be set by the shell before Node starts: see the `test:tz`
   * scripts and the `unit-tz` project.
   */
  const TZ_ASSIGNMENT = /process\.env\.TZ\s*=/;

  const testFiles = globSync('tests/**/*.{ts,tsx,cjs,mjs}').map((f) => f.toString());

  it('the scan found the test tree', () => {
    // A broken glob makes the assertion below vacuous.
    expect(testFiles.length).toBeGreaterThan(30);
  });

  /** Comments stripped — a docblock QUOTING the banned pattern is not using it. */
  function codeOnly(source: string): string {
    const out: string[] = [];
    let inBlock = false;

    for (const raw of source.split('\n')) {
      let line = raw;

      if (inBlock) {
        const end = line.indexOf('*/');
        if (end === -1) continue;
        line = line.slice(end + 2);
        inBlock = false;
      }

      const block = line.indexOf('/*');
      if (block !== -1) {
        const end = line.indexOf('*/', block + 2);
        if (end === -1) {
          line = line.slice(0, block);
          inBlock = true;
        } else {
          line = line.slice(0, block) + line.slice(end + 2);
        }
      }

      const lineComment = line.indexOf('//');
      if (lineComment !== -1) line = line.slice(0, lineComment);

      out.push(line);
    }

    return out.join('\n');
  }

  it('the comment stripper does not swallow real code', () => {
    // Without this, a stripper that returned '' would make the rule vacuous —
    // and this whole describe block exists because something looked like it
    // was working and was not.
    expect(codeOnly('const a = 1; // process.env.TZ = "x"')).not.toMatch(TZ_ASSIGNMENT);
    expect(codeOnly('process.env.TZ = "x";')).toMatch(TZ_ASSIGNMENT);
    expect(codeOnly('/* process.env.TZ = "x" */\nconst b = 2;')).toContain('const b = 2');
  });

  it('no test file assigns process.env.TZ', () => {
    const offenders = testFiles
      // This file states the pattern as code in order to test the matcher
      // above. Excluded by name rather than by a comment trick, so the
      // exclusion is visible.
      .filter((f) => !f.endsWith('test-infra-integrity.test.ts'))
      .filter((f) => TZ_ASSIGNMENT.test(codeOnly(readFileSync(f, 'utf8'))));

    if (offenders.length > 0) {
      throw new Error(
        `Assigning process.env.TZ inside a test does nothing:\n\n` +
          offenders.map((o) => `  ${o}`).join('\n') +
          `\n\nNode caches the zone and jest's sandboxed process never triggers a\n` +
          `tzset, so the file runs under the host's zone while LOOKING pinned.\n\n` +
          `Put the file in tests/unit-tz/ instead — \`npm run test:tz\` runs that\n` +
          `project twice with TZ set by the shell, once from each side of\n` +
          `Greenwich, so the direction does not have to be guessed.`,
      );
    }
  });
});
