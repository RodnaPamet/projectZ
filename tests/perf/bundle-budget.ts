import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { firstLoadJs, stringify, type FirstLoadJs } from './report';

/**
 * First Load JS per route against docs/perf/bundle-budget.json (T30).
 *
 *   npm run build && npx tsx tests/perf/bundle-budget.ts
 *       Print every route's gzip KB against its budget. REPORT-ONLY: it exits
 *       0 when a route is over (T29 turns this into a CI gate). It exits 2,
 *       loudly, when the build's manifests cannot be read, because a
 *       report of "no routes" would look like a pass.
 *
 *   npx tsx tests/perf/bundle-budget.ts --write
 *       Set the budget from the current build.
 *
 * The number is the one `firstLoadJs()` (tests/perf/report.ts) rebuilds from
 * the build output, since Next 16 with Turbopack no longer prints a size
 * column: the root main files plus every layout's and page's entry chunks,
 * gzip -9. The budget is the measured value; anything above it is reported.
 */

export const BUNDLE_BUDGET_PATH = 'docs/perf/bundle-budget.json';
export const BUNDLE_BUDGET_SCHEMA = 'playerz-first-load-js/budget@1';

export interface BundleBudgetDoc {
  schema: typeof BUNDLE_BUDGET_SCHEMA;
  /** Where the numbers came from: the commit and Next version of the build. */
  source: string;
  unit: 'gzip KB';
  routes: Record<string, number>;
}

function measure(nextDir: string): FirstLoadJs[] {
  for (const f of ['build-manifest.json', 'app-path-routes-manifest.json']) {
    if (!existsSync(join(nextDir, f))) {
      throw new Error(`${join(nextDir, f)} is missing: run \`npm run build\` first.`);
    }
  }
  const routes = firstLoadJs(nextDir);
  if (routes.length === 0) {
    throw new Error(
      `${nextDir} has build manifests but no route could be read from them. The build ` +
        "output's shape has changed; fix firstLoadJs() in tests/perf/report.ts.",
    );
  }
  return routes;
}

function main(args: string[]): number {
  let routes: FirstLoadJs[];
  try {
    routes = measure('.next');
  } catch (e) {
    process.stderr.write(`bundle-budget: ${(e as Error).message}\n`);
    return 2;
  }

  if (args[0] === '--write') {
    const next = JSON.parse(readFileSync('node_modules/next/package.json', 'utf8')) as {
      version: string;
    };
    const doc: BundleBudgetDoc = {
      schema: BUNDLE_BUDGET_SCHEMA,
      source: `next build, Next ${next.version}, ${args[1] ?? 'this tree'}`,
      unit: 'gzip KB',
      routes: Object.fromEntries(routes.map((r) => [r.route, r.gzipKB])),
    };
    writeFileSync(BUNDLE_BUDGET_PATH, stringify(doc));
    process.stdout.write(`wrote ${BUNDLE_BUDGET_PATH}: ${routes.length} routes\n`);
    return 0;
  }

  const budget = JSON.parse(readFileSync(BUNDLE_BUDGET_PATH, 'utf8')) as BundleBudgetDoc;
  const lines = [
    '| Route | Budget (gzip KB) | Now | Δ KB | |',
    '| --- | ---: | ---: | ---: | --- |',
  ];
  let over = 0;
  for (const r of routes) {
    const b = budget.routes[r.route];
    const d = b == null ? null : Math.round((r.gzipKB - b) * 10) / 10;
    const verdict = b == null ? 'no budget' : d! > 0 ? '**OVER**' : '';
    if (verdict === '**OVER**') over++;
    lines.push(
      `| \`${r.route}\` | ${b ?? '—'} | ${r.gzipKB} | ${d == null ? '—' : `${d > 0 ? '+' : ''}${d}`} | ${verdict} |`,
    );
  }
  const gone = Object.keys(budget.routes).filter((k) => !routes.some((r) => r.route === k));
  process.stdout.write(`${lines.join('\n')}\n\n`);
  if (gone.length) process.stdout.write(`Budgeted routes not in this build: ${gone.join(', ')}\n`);
  process.stdout.write(`${over} route(s) over budget. Report-only: T29 makes this a CI gate.\n`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
