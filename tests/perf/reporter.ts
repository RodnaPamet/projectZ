import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, release, totalmem, type } from 'node:os';

import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { formatInTimeZone } from 'date-fns-tz';

import {
  CLUB_TIMEZONE,
  PERF_BASE_URL,
  PERF_DIR,
  PERF_RUNS,
  PERF_WARM_PASSES,
  PROFILES,
  QUIET_MS,
  RUNS_DIR,
} from './config';
import type { Sample } from './harness';
import {
  buildRows,
  firstLoadJs,
  firstLoadTable,
  gitInfo,
  networkTable,
  readyTable,
  RUN_SCHEMA,
  stringify,
  firstTable,
  writeTable,
  type RunDoc,
} from './report';

/**
 * Collects every test's `perf-samples` attachment, and when the run ends,
 * writes `.perf/runs/nav-<sha>-<time>.json` and prints the tables.
 *
 * The file is local: a run is one measurement, not a result. A baseline is
 * two or more runs merged by `npm run perf:compare -- --merge`, and that is
 * what gets committed (docs/perf/README.md).
 */
export default class PerfReporter implements Reporter {
  private readonly samples: Sample[] = [];
  private readonly failures: string[] = [];
  private readonly warnings: string[] = [];
  private readonly startedAt = new Date();
  private readonly loadStart = loadavg().map((v) => Math.round(v * 100) / 100);
  private browser: string | null = null;

  printsToStdio() {
    return false;
  }

  onTestEnd(test: TestCase, result: TestResult) {
    for (const a of result.attachments) {
      if (a.name !== 'perf-samples' || !a.body) continue;
      const got = JSON.parse(a.body.toString('utf8')) as {
        browser: string;
        samples: Sample[];
        warnings?: string[];
      };
      this.browser ??= got.browser;
      this.samples.push(...got.samples);
      for (const w of got.warnings ?? []) this.warnings.push(`${test.title}: ${w}`);
    }
    if (result.status !== 'passed' && result.status !== 'skipped') {
      const where = test.parent.project()?.name ?? '?';
      this.failures.push(
        `[${where}] ${test.title}: ${(result.error?.message ?? result.status).split('\n')[0]}`,
      );
    }
  }

  async onEnd(result: FullResult) {
    if (this.samples.length === 0) {
      process.stdout.write('\n[perf] no samples were collected; nothing written.\n');
      return;
    }

    const git = gitInfo();
    let seed: Record<string, unknown> | null = null;
    try {
      seed = JSON.parse(readFileSync(`${PERF_DIR}/seed.json`, 'utf8')) as Record<string, unknown>;
    } catch {
      seed = null;
    }
    const nextPkg = JSON.parse(readFileSync('node_modules/next/package.json', 'utf8')) as {
      version: string;
    };
    const pwPkg = JSON.parse(
      readFileSync('node_modules/@playwright/test/package.json', 'utf8'),
    ) as {
      version: string;
    };

    const doc: RunDoc = {
      schema: RUN_SCHEMA,
      startedAt: this.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      clubLocalStart: formatInTimeZone(this.startedAt, CLUB_TIMEZONE, 'yyyy-MM-dd HH:mm'),
      git,
      env: {
        node: process.version,
        next: nextPkg.version,
        playwright: pwPkg.version,
        chromium: this.browser,
        os: `${type()} ${release()}`,
        cpu: cpus()[0]?.model ?? 'unknown',
        cores: cpus().length,
        memGB: Math.round(totalmem() / 2 ** 30),
        loadavgStart: this.loadStart,
        loadavgEnd: loadavg().map((v) => Math.round(v * 100) / 100),
        status: result.status,
      },
      config: {
        baseURL: PERF_BASE_URL,
        runs: PERF_RUNS,
        warmPasses: PERF_WARM_PASSES,
        quietMs: QUIET_MS,
        profiles: Object.fromEntries(
          Object.values(PROFILES).map((p) => [
            p.id,
            {
              device: p.device.userAgent.includes('Mobile') ? 'Pixel 5' : 'Desktop Chrome',
              viewport: p.device.viewport,
              deviceScaleFactor: p.device.deviceScaleFactor,
              cpuThrottlingRate: p.cpuThrottlingRate,
              network: p.network,
              input: p.input,
            },
          ]),
        ),
      },
      seed,
      buildId: existsSync('.next/BUILD_ID') ? readFileSync('.next/BUILD_ID', 'utf8').trim() : null,
      buildSkipped: process.env.PERF_SKIP_BUILD === '1',
      failures: this.failures,
      warnings: this.warnings,
      firstLoadJs: firstLoadJs(),
      rows: buildRows(this.samples),
      samples: this.samples,
    };

    mkdirSync(RUNS_DIR, { recursive: true });
    const stamp = this.startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const path = `${RUNS_DIR}/nav-${git.base ?? git.head}-${stamp}.json`;
    writeFileSync(path, stringify(doc));

    const out = process.stdout;
    out.write(
      '\n══ Navigation latency: time to key content painted, ms (median / p75 / p95) ══\n\n',
    );
    out.write(`${readyTable(doc.rows)}\n\n`);
    out.write('══ What each navigation cost: phone, cold ══\n\n');
    out.write(`${networkTable(doc.rows)}\n\n`);
    const firsts = firstTable(doc.rows);
    if (firsts) {
      out.write('══ Two-stage pages: skeleton, first content, RSC, ready; medians, ms ══\n\n');
      out.write(`${firsts}\n\n`);
    }
    const writes = writeTable(doc.rows);
    if (writes) {
      out.write('══ What each write cost: submit to 3 s after commit, medians ══\n\n');
      out.write(`${writes}\n\n`);
    }
    if (doc.firstLoadJs.length > 0) {
      out.write('══ First Load JS per route (from the build) ══\n\n');
      out.write(`${firstLoadTable(doc.firstLoadJs)}\n\n`);
    }
    out.write(
      `[perf] ${this.samples.length} samples, ${doc.rows.length} rows → ${path}\n` +
        `[perf] app code at ${git.base ?? '?'} (HEAD ${git.head}${git.dirty ? ', DIRTY' : ''}); ` +
        `load average ${this.loadStart.join(' ')} → ${(doc.env.loadavgEnd as number[]).join(' ')}\n`,
    );
    if (doc.buildSkipped) {
      out.write('[perf] WARNING: PERF_SKIP_BUILD=1, so this run measured an existing build.\n');
    }
    if (this.failures.length > 0) {
      out.write(
        `[perf] ${this.failures.length} test(s) failed:\n  ${this.failures.join('\n  ')}\n`,
      );
    }
    if (this.warnings.length > 0) {
      out.write(
        `[perf] ${this.warnings.length} warning(s), first five:\n  ${this.warnings.slice(0, 5).join('\n  ')}\n`,
      );
    }
    if (!existsSync('.next/BUILD_ID')) {
      out.write('[perf] WARNING: no .next/BUILD_ID; First Load JS could not be computed.\n');
    }
  }
}
