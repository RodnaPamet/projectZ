import { globSync, readFileSync } from 'node:fs';

import { BUDGET_PATH, BUDGET_SCHEMA, ceilingFor, timedRows, type BudgetDoc } from '../perf/budget';
import {
  BUNDLE_BUDGET_SCHEMA,
  budgetFor,
  judge,
  type BundleBudgetDoc,
} from '../perf/bundle-budget';
import { BASELINE_SCHEMA, rowKey, type BaselineDoc } from '../perf/report';

/**
 * THE PERF BUDGET MATCHES THE BASELINE IT WAS SET FROM (T30).
 *
 * ═══ WHY ═══
 *
 * `tests/perf/budget.ts` judges a run against docs/perf/budget.json, one
 * ceiling per row. A budget that has drifted from the committed baseline
 * judges the wrong thing without saying so: a new journey with no entry is
 * never checked, and an entry for a step that was renamed or removed can
 * never be met, so everyone learns to ignore the failure. This keeps the two
 * files in step. It does not run the harness (timings on a CI runner are
 * noise; docs/perf/README.md): it checks the files a perf PR commits.
 *
 * "Newest" is by the baseline's own `createdAt`: the file names are commit
 * shas, which do not sort.
 */

const load = <T>(path: string) => JSON.parse(readFileSync(path, 'utf8')) as T;

const baselines = globSync('docs/perf/baseline-*.json')
  .map((f) => ({ path: f.toString(), doc: load<BaselineDoc>(f.toString()) }))
  .sort((a, b) => a.doc.createdAt.localeCompare(b.doc.createdAt));
const newest = baselines[baselines.length - 1]!;
const budget = load<BudgetDoc>(BUDGET_PATH);
const bundle = load<{ schema: string; unit: string; routes: Record<string, number> }>(
  'docs/perf/bundle-budget.json',
);

describe('perf budget', () => {
  it('finds the committed baselines, and the newest one parses', () => {
    expect(baselines.length).toBeGreaterThan(0);
    expect(newest.doc.schema).toBe(BASELINE_SCHEMA);
    expect(newest.doc.runs.length).toBeGreaterThanOrEqual(2);
    expect(timedRows(newest.doc.pooled).length).toBeGreaterThan(0);
  });

  it('was set from the newest baseline', () => {
    expect(budget.schema).toBe(BUDGET_SCHEMA);
    expect(budget.source).toBe(newest.path);
  });

  it('has an entry for every timed row of the newest baseline', () => {
    const missing = timedRows(newest.doc.pooled)
      .map(rowKey)
      .filter((k) => !(k in budget.rows));
    expect(missing).toEqual([]);
  });

  it('has no stale entry: every one names a row the baseline measured', () => {
    const keys = new Set(timedRows(newest.doc.pooled).map(rowKey));
    expect(Object.keys(budget.rows).filter((k) => !keys.has(k))).toEqual([]);
  });

  it("follows its own rule, from the baseline's medians", () => {
    const wrong = timedRows(newest.doc.pooled)
      .map((r) => ({ key: rowKey(r), median: r.stats.tReady!.median }))
      .filter(
        ({ key, median }) =>
          budget.rows[key]?.median !== median || budget.rows[key]?.ceiling !== ceilingFor(median),
      );
    expect(wrong).toEqual([]);
  });

  it('keeps a First Load JS budget for the app routes', () => {
    expect(bundle.unit).toBe('gzip KB');
    expect(Object.keys(bundle.routes)).toEqual(
      expect.arrayContaining(['/', '/venues', '/me/bookings', '/t/[slug]/admin/calendar']),
    );
    for (const kb of Object.values(bundle.routes)) expect(kb).toBeGreaterThan(0);
  });

  it('the First Load JS budget says its rule, and was written by --write (T29)', () => {
    expect(bundle.schema).toBe(BUNDLE_BUDGET_SCHEMA);
    expect((bundle as BundleBudgetDoc).rule).toBe(
      'measured First Load JS + 5%, rounded up to 0.1 KB',
    );
  });
});

// ── The --enforce verdict (the CI gate), on data ─────────────────────

describe('bundle-budget --enforce', () => {
  const doc: BundleBudgetDoc = {
    schema: BUNDLE_BUDGET_SCHEMA,
    source: 'test',
    unit: 'gzip KB',
    routes: { '/': 100, '/venues': 200 },
  };
  const route = (r: string, gzipKB: number) => ({ route: r, gzipKB, rawKB: 0, files: 1 });

  it('passes a build within budget', () => {
    expect(judge([route('/', 100), route('/venues', 150)], doc)).toEqual({
      over: [],
      unbudgeted: [],
      gone: [],
    });
  });

  it('fails a route over budget, a route with none, and a budgeted route not built', () => {
    expect(judge([route('/', 100.1), route('/new', 50)], doc)).toEqual({
      over: ['/: 100.1 KB > 100 KB'],
      unbudgeted: ['/new'],
      gone: ['/venues'],
    });
  });

  it('sets a budget 5% over the measurement, rounded up', () => {
    expect(budgetFor(100)).toBe(105);
    expect(budgetFor(196.4)).toBe(206.3);
  });
});
