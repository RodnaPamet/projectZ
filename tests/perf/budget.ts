import { readFileSync, writeFileSync } from 'node:fs';

import { isBaseline, rowKey, stringify, type BaselineDoc, type Row, type RunDoc } from './report';

/**
 * The navigation-latency budget (T30): a ceiling per row, and the check.
 *
 *   npx tsx tests/perf/budget.ts <merged.json>
 *       Exit 1 if any row's median time-to-ready is over its ceiling in
 *       docs/perf/budget.json, printing those rows. Exit 1 too if the budget
 *       names a row the file did not measure: a journey that stopped running
 *       would otherwise pass every budget by having no numbers.
 *
 *   npx tsx tests/perf/budget.ts --write <merged.json>
 *       Set docs/perf/budget.json from a merged baseline. Done once per
 *       committed baseline (docs/perf/README.md, "Comparing a change").
 *
 * ═══ THE CEILING ═══
 *
 * max(median × 1.15, median + 50 ms), from the merged runs of the change that
 * set it. The 15% is for slow rows, where the machine's own drift is
 * proportional. The 50 ms is for fast ones: a warm revisit served from the
 * router cache is 30-60 ms on the phone, and ±15% of that is a few
 * milliseconds of scheduling noise. 50 ms is still far less than what a lost
 * cache hit costs (a round trip and the 300 ms Suspense throttle, #290), so
 * the budget catches the regression it exists for.
 *
 * Only rows with a time are budgeted. A write (harness.ts `write`) is
 * untimed; its request counts are reported, not budgeted.
 */

export const BUDGET_PATH = 'docs/perf/budget.json';
export const BUDGET_SCHEMA = 'playerz-nav-latency/budget@1';

export interface BudgetDoc {
  schema: typeof BUDGET_SCHEMA;
  /** The merged baseline the ceilings came from. */
  source: string;
  rule: string;
  /** rowKey → the median it was set from, and the ceiling. */
  rows: Record<string, { median: number; ceiling: number }>;
}

export const ceilingFor = (median: number) => Math.ceil(Math.max(median * 1.15, median + 50));

const rowsOf = (d: RunDoc | BaselineDoc): Row[] => (isBaseline(d) ? d.pooled : d.rows);

/** The rows a budget covers: every row with a time-to-ready median. */
export const timedRows = (rows: Row[]) => rows.filter((r) => r.stats.tReady?.median != null);

export function makeBudget(doc: RunDoc | BaselineDoc, source: string): BudgetDoc {
  const rows: BudgetDoc['rows'] = {};
  for (const r of timedRows(rowsOf(doc))) {
    const median = r.stats.tReady!.median;
    rows[rowKey(r)] = { median, ceiling: ceilingFor(median) };
  }
  return {
    schema: BUDGET_SCHEMA,
    source,
    rule: 'ceiling = ceil(max(median × 1.15, median + 50 ms)), median time to ready',
    rows,
  };
}

export function checkBudget(
  doc: RunDoc | BaselineDoc,
  budget: BudgetDoc,
): { over: string[]; missing: string[]; unbudgeted: string[]; checked: number } {
  const measured = new Map(timedRows(rowsOf(doc)).map((r) => [rowKey(r), r]));
  const over: string[] = [];
  const missing: string[] = [];
  let checked = 0;
  for (const [key, b] of Object.entries(budget.rows)) {
    const r = measured.get(key);
    if (!r) {
      missing.push(key);
      continue;
    }
    checked++;
    const m = r.stats.tReady!.median;
    if (m > b.ceiling) {
      over.push(
        `${key}: median ${Math.round(m)} ms > ceiling ${b.ceiling} ms (set from ${Math.round(b.median)} ms)`,
      );
    }
  }
  const unbudgeted = [...measured.keys()].filter((k) => !(k in budget.rows));
  return { over, missing, unbudgeted, checked };
}

function main(args: string[]) {
  const load = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as RunDoc | BaselineDoc;
  if (args[0] === '--write' && args[1]) {
    const budget = makeBudget(load(args[1]), args[1]);
    writeFileSync(BUDGET_PATH, stringify(budget));
    process.stdout.write(`wrote ${BUDGET_PATH}: ${Object.keys(budget.rows).length} rows\n`);
    return 0;
  }
  if (args.length !== 1) {
    process.stderr.write(
      'usage:\n' +
        '  npx tsx tests/perf/budget.ts <merged.json>\n' +
        '  npx tsx tests/perf/budget.ts --write <merged.json>\n',
    );
    return 2;
  }
  const budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8')) as BudgetDoc;
  const { over, missing, unbudgeted, checked } = checkBudget(load(args[0]!), budget);
  process.stdout.write(`${checked} rows checked against ${BUDGET_PATH}.\n`);
  if (unbudgeted.length) {
    process.stdout.write(
      `${unbudgeted.length} measured row(s) have no budget yet (new journeys; set one with --write):\n  ${unbudgeted.join('\n  ')}\n`,
    );
  }
  if (missing.length) {
    process.stdout.write(
      `FAIL: ${missing.length} budgeted row(s) were not measured:\n  ${missing.join('\n  ')}\n`,
    );
  }
  if (over.length) {
    process.stdout.write(`FAIL: ${over.length} row(s) over budget:\n  ${over.join('\n  ')}\n`);
  }
  if (!missing.length && !over.length) process.stdout.write('Every row is within its budget.\n');
  return missing.length || over.length ? 1 : 0;
}

// Run only as a script: the guardrail imports the helpers above.
if (/(^|[/\\])budget\.ts$/.test(process.argv[1] ?? '')) {
  process.exit(main(process.argv.slice(2)));
}
