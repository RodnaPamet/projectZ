import { readFileSync, writeFileSync } from 'node:fs';

import {
  BASELINE_SCHEMA,
  firstLoadTable,
  isBaseline,
  networkTable,
  poolRows,
  quantile,
  readyTable,
  rowKey,
  stringify,
  writeTable,
  type BaselineDoc,
  type Row,
  type RunDoc,
  type VarianceRow,
} from './report';

/**
 * `npm run perf:compare -- …`: make a baseline from runs, and judge a change
 * against one.
 *
 *   --merge <run.json> <run.json> [...] --out docs/perf/baseline-<sha>.json
 *       Pool two or more runs of the SAME code into a baseline. It records
 *       how far apart the runs' medians were, which is the noise any later
 *       difference has to beat.
 *
 *   <baseline.json> <run-or-baseline.json>
 *       Before/after, per step and profile: medians, the difference, and
 *       whether that difference is bigger than the baseline's own run-to-run
 *       noise.
 *
 *   --tables <file.json>
 *       Print a file's tables as markdown, for a README or a PR body.
 */

type Doc = RunDoc | BaselineDoc;

const load = (path: string): Doc => JSON.parse(readFileSync(path, 'utf8')) as Doc;
const rowsOf = (d: Doc): Row[] => (isBaseline(d) ? d.pooled : d.rows);
const runsOf = (d: Doc): Array<Omit<RunDoc, 'samples'>> => (isBaseline(d) ? d.runs : [d]);

function merge(paths: string[], out: string) {
  const runs = paths.map(load).flatMap(runsOf);
  if (runs.length < 2) throw new Error('--merge needs at least two runs: variance needs two.');

  const bases = new Set(runs.map((r) => r.git.base ?? r.git.head));
  if (bases.size > 1) {
    throw new Error(
      `these runs measured different code (${[...bases].join(', ')}); refusing to pool them`,
    );
  }

  const pooled = poolRows(runs.map((r) => r.rows));

  // Run-to-run: how far apart each run's MEDIAN t_ready was, for the same row.
  const variance: VarianceRow[] = [];
  for (const row of pooled) {
    const key = rowKey(row);
    const medians = runs
      .map((r) => r.rows.find((x) => rowKey(x) === key)?.stats.tReady?.median)
      .filter((v): v is number => v != null);
    if (medians.length < 2) continue;
    const hi = Math.max(...medians);
    const lo = Math.min(...medians);
    const mid = row.stats.tReady?.median ?? (hi + lo) / 2;
    variance.push({
      key,
      metric: 'tReady',
      medians,
      absDelta: Math.round((hi - lo) * 10) / 10,
      relDelta: mid > 0 ? Math.round(((hi - lo) / mid) * 1000) / 1000 : 0,
    });
  }

  const summarise = (vs: VarianceRow[]) => {
    const abs = vs.map((v) => v.absDelta).sort((a, b) => a - b);
    const rel = vs.map((v) => v.relDelta).sort((a, b) => a - b);
    return {
      rows: vs.length,
      absMs: { median: q(abs, 0.5), p90: q(abs, 0.9), max: abs[abs.length - 1] ?? null },
      rel: { median: q(rel, 0.5), p90: q(rel, 0.9), max: rel[rel.length - 1] ?? null },
    };
  };
  const by = (profile: string, mode?: string) =>
    variance.filter(
      (v) => v.key.startsWith(`${profile}|`) && (!mode || v.key.endsWith(`|${mode}`)),
    );

  const doc: BaselineDoc = {
    schema: BASELINE_SCHEMA,
    createdAt: new Date().toISOString(),
    git: runs[0]!.git,
    // Each run keeps the headline STATS it contributes to the variance; the
    // individual values, and every metric, live once, in `pooled`.
    runs: runs.map((r) => {
      const keep = ['tReady', 'tFeedback', 'requests', 'bytes', 'payloadDecoded'] as const;
      const rows = r.rows.map((row) => ({
        ...row,
        values: {},
        stats: Object.fromEntries(keep.filter((m) => row.stats[m]).map((m) => [m, row.stats[m]])),
      }));
      const copy = { ...r, rows } as RunDoc;
      delete copy.samples;
      return copy;
    }),
    pooled,
    variance,
    varianceSummary: {
      all: summarise(variance),
      phone: summarise(by('phone')),
      phoneCold: summarise(by('phone', 'cold')),
      phoneWarm: summarise(by('phone', 'warm')),
      desktop: summarise(by('desktop')),
      desktopCold: summarise(by('desktop', 'cold')),
      desktopWarm: summarise(by('desktop', 'warm')),
    },
  };
  writeFileSync(out, stringify(doc));
  process.stdout.write(`wrote ${out}: ${runs.length} runs, ${pooled.length} rows\n`);
  process.stdout.write(`${JSON.stringify(doc.varianceSummary, null, 2)}\n`);
}

const q = (sorted: number[], p: number) =>
  sorted.length ? Math.round(quantile(sorted, p) * 1000) / 1000 : null;

/**
 * What counts as a REAL difference for one row: bigger than twice the
 * baseline's own run-to-run spread for that row, and bigger than 10% and
 * 20 ms. Twice, because the candidate is itself one noisy run. The floors,
 * because a 3 ms change in a 40 ms back-button step is not news, whatever
 * the spread says.
 */
function threshold(base: BaselineDoc | null, key: string, median: number): number {
  const spread = base?.variance.find((v) => v.key === key)?.absDelta ?? 0;
  return Math.max(2 * spread, 0.1 * median, 20);
}

function compare(beforePath: string, afterPath: string) {
  const before = load(beforePath);
  const after = load(afterPath);
  const baseDoc = isBaseline(before) ? before : null;
  if (!baseDoc) {
    process.stdout.write(
      'note: the "before" file is a single run, so there is no measured noise to judge by; ' +
        'only the 10% / 20 ms floors apply. Merge two runs into a baseline first.\n\n',
    );
  }

  const hours = (d: Doc) => runsOf(d).map((r) => Number(r.clubLocalStart.slice(11, 13)));
  const gap = Math.max(...hours(before).flatMap((a) => hours(after).map((b) => Math.abs(a - b))));
  if (gap >= 3) {
    process.stdout.write(
      `warning: these runs started ${gap}h apart in the club's day. Which of today's bookings ` +
        'have started, and so how much of the diary offers a no-show control, depends on the ' +
        'hour (seed-perf.ts). Compare runs taken at similar times.\n\n',
    );
  }

  const b = rowsOf(before);
  const a = rowsOf(after);
  const lines = [
    '| Profile · mode | Journey · step | Before (median ms) | After (median ms) | Δ ms | Δ % | Verdict |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
  ];
  let faster = 0;
  let slower = 0;
  // Per profile and mode, because a cache policy moves warm rows and leaves
  // cold ones alone: a pooled verdict would hide exactly what changed (#290).
  const groups = new Map<string, { deltas: number[]; faster: number; slower: number }>();
  for (const rb of b) {
    const key = rowKey(rb);
    const ra = a.find((x) => rowKey(x) === key);
    const mb = rb.stats.tReady?.median;
    const ma = ra?.stats.tReady?.median;
    if (mb == null || ma == null) continue;
    const d = ma - mb;
    const t = threshold(baseDoc, key, mb);
    const verdict = Math.abs(d) <= t ? 'within noise' : d < 0 ? '**faster**' : '**SLOWER**';
    if (verdict === '**faster**') faster++;
    if (verdict === '**SLOWER**') slower++;
    const g = `${rb.profile} ${rb.mode}${rb.kind === 'hard' ? ' (full loads)' : ''}`;
    const acc = groups.get(g) ?? { deltas: [], faster: 0, slower: 0 };
    acc.deltas.push(d);
    if (verdict === '**faster**') acc.faster++;
    if (verdict === '**SLOWER**') acc.slower++;
    groups.set(g, acc);
    lines.push(
      `| ${rb.profile} ${rb.mode} | ${rb.journey} · ${rb.step} | ${Math.round(mb)} | ${Math.round(ma)} | ${d > 0 ? '+' : ''}${Math.round(d)} | ${d > 0 ? '+' : ''}${Math.round((d / mb) * 100)}% | ${verdict} |`,
    );
  }
  const missing = a.filter((ra) => !b.some((rb) => rowKey(rb) === rowKey(ra)));
  process.stdout.write(`${lines.join('\n')}\n\n`);
  process.stdout.write(`${faster} faster, ${slower} slower, beyond noise.\n\n`);
  const summary = [
    '| Profile · mode | Rows | Faster | Slower | Median Δ ms | Range Δ ms |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const [g, acc] of groups) {
    const s = [...acc.deltas].sort((x, y) => x - y);
    summary.push(
      `| ${g} | ${s.length} | ${acc.faster} | ${acc.slower} | ${Math.round(quantile(s, 0.5))} | ${Math.round(s[0]!)} … ${Math.round(s[s.length - 1]!)} |`,
    );
  }
  process.stdout.write(`${summary.join('\n')}\n`);
  if (missing.length > 0) {
    process.stdout.write(
      `${missing.length} row(s) exist only in the "after" file: ${missing.map(rowKey).join('; ')}\n`,
    );
  }
}

function tables(path: string) {
  const d = load(path);
  const rows = rowsOf(d);
  process.stdout.write(`${readyTable(rows)}\n\n${networkTable(rows)}\n\n`);
  const writes = writeTable(rows);
  if (writes) process.stdout.write(`${writes}\n\n`);
  const fl = runsOf(d)[0]?.firstLoadJs ?? [];
  if (fl.length) process.stdout.write(`${firstLoadTable(fl)}\n`);
  if (isBaseline(d)) {
    process.stdout.write(`\n${JSON.stringify(d.varianceSummary, null, 2)}\n`);
  }
}

const args = process.argv.slice(2);
if (args[0] === '--merge') {
  const outAt = args.indexOf('--out');
  if (outAt < 0 || !args[outAt + 1]) throw new Error('--merge needs --out <path>');
  merge(
    args.slice(1).filter((_, i) => i + 1 !== outAt && i + 1 !== outAt + 1),
    args[outAt + 1]!,
  );
} else if (args[0] === '--tables' && args[1]) {
  tables(args[1]);
} else if (args.length === 2) {
  compare(args[0]!, args[1]!);
} else {
  process.stderr.write(
    'usage:\n' +
      '  npm run perf:compare -- <baseline.json> <run.json>\n' +
      '  npm run perf:compare -- --merge <run.json> <run.json> --out docs/perf/baseline-<sha>.json\n' +
      '  npm run perf:compare -- --tables <file.json>\n',
  );
  process.exit(2);
}
