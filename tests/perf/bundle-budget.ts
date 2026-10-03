import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { firstLoadJs, stringify, type FirstLoadJs } from './report';

/**
 * First Load JS per route against docs/perf/bundle-budget.json (T30, enforced by T29).
 *
 *   npm run build && npm run perf:bundle
 *       Print every route's gzip KB against its budget. Report-only: exits 0
 *       whatever the numbers say.
 *
 *   npm run build && npm run perf:bundle -- --enforce
 *       The CI gate, run in the Build job right after `next build`. Exits 1
 *       when a route is over its budget, when a built route has no budget, or
 *       when a budgeted route was not built: each means the budget no longer
 *       describes the app, and a stale budget is one nobody reads.
 *
 *   npx tsx tests/perf/bundle-budget.ts --write <sha>
 *       Set the budget from the current build: each route's measured KB plus
 *       HEADROOM.
 *
 * Every mode exits 2, loudly, when the build's manifests cannot be read,
 * because a report of "no routes" would look like a pass (fail-closed).
 *
 * The number is the one `firstLoadJs()` (tests/perf/report.ts) rebuilds from
 * the build output, since Next 16 with Turbopack no longer prints a size
 * column: the root main files plus every layout's and page's entry chunks,
 * gzip -9.
 *
 * ═══ HEADROOM ═══
 *
 * 5% over the measured build. Two builds of the same tree measure the same
 * bytes, so the margin is not for noise: it is the size of change that
 * passes without a conversation. 5% of the largest route (/t/[slug]/admin/staff,
 * 335 KB at T29) is ~17 KB gzip, about one small dependency; anything bigger is a
 * decision the PR should state, by re-running --write and committing it.
 */

export const BUNDLE_BUDGET_PATH = 'docs/perf/bundle-budget.json';
export const BUNDLE_BUDGET_SCHEMA = 'playerz-first-load-js/budget@1';
export const HEADROOM = 1.05;

export interface BundleBudgetDoc {
  schema: typeof BUNDLE_BUDGET_SCHEMA;
  /** Where the numbers came from: the commit and Next version of the build. */
  source: string;
  unit: 'gzip KB';
  /** The rule each route's number follows. */
  rule?: string;
  routes: Record<string, number>;
}

/** A route's budget from its measured size: + HEADROOM, rounded up to 0.1 KB. */
// Rounded to 0.01 KB first, so float error (1.05 is not exact) never adds 0.1 KB.
export const budgetFor = (gzipKB: number) =>
  Math.ceil(Math.round(gzipKB * HEADROOM * 1000) / 100) / 10;

export interface BundleVerdict {
  over: string[];
  unbudgeted: string[];
  gone: string[];
}

/** What --enforce fails on, as data, so the guardrail can test it without a build. */
export function judge(routes: FirstLoadJs[], budget: BundleBudgetDoc): BundleVerdict {
  const over: string[] = [];
  const unbudgeted: string[] = [];
  for (const r of routes) {
    const b = budget.routes[r.route];
    if (b == null) unbudgeted.push(r.route);
    else if (r.gzipKB > b) over.push(`${r.route}: ${r.gzipKB} KB > ${b} KB`);
  }
  const gone = Object.keys(budget.routes).filter((k) => !routes.some((r) => r.route === k));
  return { over, unbudgeted, gone };
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
      rule: `measured First Load JS + ${Math.round((HEADROOM - 1) * 100)}%, rounded up to 0.1 KB`,
      routes: Object.fromEntries(routes.map((r) => [r.route, budgetFor(r.gzipKB)])),
    };
    writeFileSync(BUNDLE_BUDGET_PATH, stringify(doc));
    process.stdout.write(`wrote ${BUNDLE_BUDGET_PATH}: ${routes.length} routes\n`);
    return 0;
  }

  const enforce = args[0] === '--enforce';
  const budget = JSON.parse(readFileSync(BUNDLE_BUDGET_PATH, 'utf8')) as BundleBudgetDoc;
  const lines = [
    '| Route | Budget (gzip KB) | Now | Δ KB | |',
    '| --- | ---: | ---: | ---: | --- |',
  ];
  for (const r of routes) {
    const b = budget.routes[r.route];
    const d = b == null ? null : Math.round((r.gzipKB - b) * 10) / 10;
    const verdict = b == null ? 'no budget' : d! > 0 ? '**OVER**' : '';
    lines.push(
      `| \`${r.route}\` | ${b ?? '—'} | ${r.gzipKB} | ${d == null ? '—' : `${d > 0 ? '+' : ''}${d}`} | ${verdict} |`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n\n`);

  const { over, unbudgeted, gone } = judge(routes, budget);
  if (gone.length) process.stdout.write(`Budgeted routes not in this build: ${gone.join(', ')}\n`);
  if (unbudgeted.length)
    process.stdout.write(`Built routes with no budget: ${unbudgeted.join(', ')}\n`);
  process.stdout.write(`${over.length} route(s) over budget.\n`);

  if (!enforce) return 0;
  const failed = over.length + unbudgeted.length + gone.length;
  if (failed) {
    process.stderr.write(
      `\nbundle-budget --enforce: FAIL. ${over.length} over, ${unbudgeted.length} without a ` +
        `budget, ${gone.length} budgeted but not built.\n` +
        `If the growth is intended, say why in the PR and reset the budget:\n` +
        `  npm run build && npx tsx tests/perf/bundle-budget.ts --write <sha>\n`,
    );
    return 1;
  }
  process.stdout.write('Every route is within its First Load JS budget.\n');
  return 0;
}

// Run only as a script: the guardrail imports judge() and budgetFor().
if (/(^|[/\\])bundle-budget\.ts$/.test(process.argv[1] ?? '')) {
  process.exit(main(process.argv.slice(2)));
}
