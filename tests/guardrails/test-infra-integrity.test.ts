import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

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

/**
 * ═══════════════════════════════════════════════════════════════════════
 *  THE NIGHTLY IS CI NOBODY WATCHES, SO IT NEEDS A TEST THAT SOMEBODY DOES
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Every assertion below is a defect that was live on main, in a workflow
 * that had been red every night without anyone looking:
 *
 *   1. `e2e-full` ran `postgres:16`. `prisma migrate deploy` issues
 *      `CREATE EXTENSION postgis` and got `extension "postgis" is not
 *      available`. ci.yml had moved to the PostGIS image at all three of
 *      its call sites; this job was left behind.
 *   2. `visual-regression` declared NO services at all, while the
 *      Playwright globalSetup migrates and seeds before any spec runs.
 *      It died at P1001 — it had never compared a single screenshot.
 *   3. The matrix ran `--project=firefox` against a config defining only
 *      `chromium` and `mobile`, so that leg could only ever have exited
 *      on `Project(s) "firefox" not found`.
 *   4. `--grep @visual` was unpinned, so it would run under whichever
 *      projects matched — and the baselines exist for exactly one.
 *
 * None of these is a broken test. All four are drift between three files
 * that have to agree and nothing forced to. That is what this asserts.
 *
 * It is deliberately structural — it parses the workflows rather than
 * grepping them — because defect 3 hides behind `${{ matrix.browser }}`,
 * which no amount of string matching resolves.
 */
describe('the nightly workflow can actually run', () => {
  const workflows = ['.github/workflows/ci.yml', '.github/workflows/nightly.yml'] as const;

  /** Every job in every workflow, tagged with where it came from. */
  const jobs = workflows.flatMap((file) => {
    const doc = parseYaml(read(file)) as {
      jobs: Record<string, Record<string, unknown>>;
    };
    return Object.entries(doc.jobs).map(([name, job]) => ({ file, name, job }));
  });

  const npmScripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
    .scripts;

  /**
   * The `steps:` of a job, flattened to the shell they run — with `npm run X`
   * expanded to what X actually is.
   *
   * Without the expansion this whole block has a blind spot exactly where the
   * bug lives: a job whose only Playwright call is `npm run test:e2e` looks,
   * to a plain scan of the YAML, like a job that never runs Playwright at all.
   */
  const shellOf = (job: Record<string, unknown>): string => {
    const raw = ((job.steps as { run?: string }[] | undefined) ?? [])
      .map((s) => s.run ?? '')
      .join('\n');

    return raw.replace(/npm run ([\w:-]+)/g, (whole, script: string) =>
      script in npmScripts ? `${whole}\n${npmScripts[script]}` : whole,
    );
  };

  const playwrightProjects = [...read('playwright.config.ts').matchAll(/name:\s*'([\w-]+)'/g)].map(
    (m) => m[1],
  );

  /**
   * Resolve `--project=${{ matrix.browser }}` against the job's own matrix.
   * Returns every project name a job could run under.
   */
  const projectsRunBy = (job: Record<string, unknown>): string[] => {
    const shell = shellOf(job);
    if (!/playwright test/.test(shell)) return [];
    // The value may be a `${{ ... }}` expression, which CONTAINS spaces — a
    // bare \S+ swallows only `${{` and reports a project nobody wrote.
    const named = [...shell.matchAll(/--project[= ](\$\{\{.*?\}\}|\S+)/g)].map((m) => m[1]);
    const matrix = ((job.strategy as { matrix?: Record<string, unknown> } | undefined)?.matrix ??
      {}) as Record<string, unknown>;

    // No --project flag at all means Playwright runs EVERY project in the
    // config. That is the shape of the regression this guards against: adding
    // a project to playwright.config.ts silently enlists every unpinned job,
    // including ones that download only one browser.
    if (named.length === 0) return playwrightProjects;

    return named.flatMap((raw) => {
      const expr = raw.match(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/);
      if (!expr) return [raw];
      const values = matrix[expr[1]];
      // A matrix reference that names no matrix key would expand to the empty
      // string and silently run EVERY project. Surface it rather than skip it.
      if (!Array.isArray(values)) return [`<unresolvable: matrix.${expr[1]}>`];
      return values.map(String);
    });
  };

  it('defines the projects the workflows ask for', () => {
    // Sanity: if this ever reads zero projects the whole block goes vacuous.
    expect(playwrightProjects).toContain('chromium');

    const missing = jobs.flatMap(({ file, name, job }) =>
      projectsRunBy(job)
        .filter((p) => !playwrightProjects.includes(p))
        .map((p) => `${file} → ${name} runs --project=${p}`),
    );

    expect(missing).toEqual([]);
  });

  it('installs a browser binary for every project it runs', () => {
    // `mobile` is a Pixel 5 EMULATION — it runs on the chromium binary, so a
    // job that installs chromium can run it. Firefox is a separate download.
    const binaryFor: Record<string, string> = {
      chromium: 'chromium',
      mobile: 'chromium',
      firefox: 'firefox',
      webkit: 'webkit',
    };

    const gaps = jobs.flatMap(({ file, name, job }) => {
      const shell = shellOf(job);
      if (!/playwright test/.test(shell)) return [];

      const installed = [...shell.matchAll(/playwright install[^\n]*/g)].join('\n');

      return (
        projectsRunBy(job)
          .map((p) => binaryFor[p])
          // An unknown project name is caught by the test above; don't double-report.
          .filter((binary): binary is string => Boolean(binary))
          .filter((binary) => !installed.includes(binary) && !/\$\{\{/.test(installed))
          .map(
            (binary) => `${file} → ${name} runs a ${binary} project but never installs ${binary}`,
          )
      );
    });

    expect(gaps).toEqual([]);
  });

  it('gives every job that touches the database a PostGIS Postgres', () => {
    const offenders = jobs.flatMap(({ file, name, job }) => {
      const services = (job.services ?? {}) as Record<string, { image?: string }>;
      const image = services.postgres?.image;
      const shell = shellOf(job);

      // A job needs a database if it migrates directly, OR if it runs
      // Playwright — whose globalSetup migrates and seeds before spec one.
      const needsDb = /prisma migrate|prisma db push|playwright test/.test(shell);
      if (!needsDb) return [];

      if (!image) return [`${file} → ${name} needs a database and declares no postgres service`];
      // The schema has a postgis extension; the stock image cannot create it.
      if (!image.includes('postgis')) {
        return [`${file} → ${name} uses ${image}, which has no postgis extension`];
      }
      return [];
    });

    expect(offenders).toEqual([]);
  });

  it('says something out loud when it fails', () => {
    // The four defects this block exists for were not subtle. They survived
    // for weeks because a scheduled run reports at 02:00 into a tab nobody
    // opens, and cannot fail a PR. Fixing the YAML fixed those four; this is
    // what stops the next one lasting weeks.
    const nightly = parseYaml(read('.github/workflows/nightly.yml')) as {
      jobs: Record<string, { needs?: string[]; if?: string; permissions?: Record<string, string> }>;
    };

    const reporter = Object.entries(nightly.jobs).find(([, job]) =>
      /contains\(needs\.\*\.result/.test(job.if ?? ''),
    );
    expect(reporter).toBeDefined();
    const [, job] = reporter!;

    // It must depend on every OTHER job, or a failure in one it forgot about
    // is a failure it stays quiet about.
    const others = Object.keys(nightly.jobs).filter((n) => n !== reporter![0]);
    expect([...(job.needs ?? [])].sort()).toEqual([...others].sort());

    // Without `always()` the job is SKIPPED precisely when a dependency
    // failed — the one case it exists for.
    expect(job.if).toContain('always()');
    // Reporting means writing an issue; the default token is read-only.
    expect(job.permissions?.issues).toBe('write');
  });

  it('pins the visual compare to the one browser that has baselines', () => {
    // The baselines are committed as `*-chromium-linux.png`. Playwright names
    // a snapshot after the project that took it, so an unpinned @visual run
    // fails as a MISSING snapshot — which reads like a real regression.
    const visual = jobs.find(({ job }) => /--grep @visual/.test(shellOf(job)));
    expect(visual).toBeDefined();
    expect(shellOf(visual!.job)).toMatch(/--project=chromium[^\n]*--grep @visual/);

    const baselines = globSync('tests/e2e/**/*-snapshots/*.png', { cwd: root });
    expect(baselines.length).toBeGreaterThan(0);
    // If firefox baselines are ever added on purpose, the pin above is what
    // should change — this catches the half-done version of that.
    expect(baselines.filter((b) => !b.includes('-chromium-'))).toEqual([]);
  });
});
