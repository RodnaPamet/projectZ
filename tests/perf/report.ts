import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';

import type { Sample } from './harness';

/**
 * Statistics, the run document, and the tables. Shared by the reporter (which
 * writes one run) and compare.ts (which merges runs and compares them), so
 * both use one definition of p75.
 */

export const RUN_SCHEMA = 'playerz-nav-latency/run@1';
export const BASELINE_SCHEMA = 'playerz-nav-latency/baseline@1';

export interface Stat {
  n: number;
  median: number;
  p75: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
}

/**
 * Linear interpolation between closest ranks (R type 7, numpy's default).
 * With ten samples p95 falls between the 9th and 10th values, so it is close
 * to the maximum. The tables say so, rather than presenting it as a stable
 * tail.
 */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function summarize(values: Array<number | null | undefined>): Stat | null {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    median: r1(quantile(s, 0.5)),
    p75: r1(quantile(s, 0.75)),
    p95: r1(quantile(s, 0.95)),
    min: r1(s[0]!),
    max: r1(s[s.length - 1]!),
    mean: r1(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

/** The per-sample metrics a row keeps, as parallel arrays. */
export const METRICS = [
  'tReady',
  'tFeedback',
  'tUrl',
  'tLoadingUi',
  'requests',
  'bytes',
  'trailingRequests',
  'trailingBytes',
  'prefetchesBefore',
  'jsBytes',
  'payloadTransfer',
  'payloadDecoded',
  'payloadTtfb',
  'payloadEnd',
  'fcp',
  'lcp',
  'redirectMs',
] as const;
export type Metric = (typeof METRICS)[number];

function metricOf(s: Sample, m: Metric): number | null {
  switch (m) {
    case 'payloadTransfer':
      return s.payload.transfer;
    case 'payloadDecoded':
      return s.payload.decoded;
    case 'payloadTtfb':
      return s.payload.ttfb;
    case 'payloadEnd':
      return s.payload.end;
    case 'fcp':
      return s.hard?.fcp ?? null;
    case 'lcp':
      return s.hard?.lcp ?? null;
    case 'redirectMs':
      return s.hard?.redirectMs ?? null;
    default:
      return s[m];
  }
}

export interface Row {
  profile: Sample['profile'];
  journey: string;
  step: string;
  mode: Sample['mode'];
  kind: Sample['kind'];
  n: number;
  /** How the first visible response came, per sample: url, loading-ui, fcp or none. */
  feedbackBy: Record<string, number>;
  loadingUi: string[];
  values: Partial<Record<Metric, Array<number | null>>>;
  stats: Partial<Record<Metric, Stat>>;
}

export const rowKey = (r: Pick<Row, 'profile' | 'journey' | 'step' | 'mode'>) =>
  `${r.profile}|${r.journey}|${r.step}|${r.mode}`;

const r0 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

/** Group samples into rows, keeping the order in which each row first appeared. */
export function buildRows(samples: Sample[]): Row[] {
  const rows = new Map<string, Row>();
  for (const s of samples) {
    const key = rowKey(s);
    let row = rows.get(key);
    if (!row) {
      row = {
        profile: s.profile,
        journey: s.journey,
        step: s.step,
        mode: s.mode,
        kind: s.kind,
        n: 0,
        feedbackBy: {},
        loadingUi: [],
        values: {},
        stats: {},
      };
      rows.set(key, row);
    }
    row.n++;
    const by = s.feedbackBy ?? 'none';
    row.feedbackBy[by] = (row.feedbackBy[by] ?? 0) + 1;
    if (s.loadingUiWhat && !row.loadingUi.includes(s.loadingUiWhat)) {
      row.loadingUi.push(s.loadingUiWhat);
    }
    for (const m of METRICS) {
      (row.values[m] ??= []).push(r0(metricOf(s, m)));
    }
  }
  return [...rows.values()].map(withStats);
}

export function withStats(row: Row): Row {
  const stats: Row['stats'] = {};
  for (const m of METRICS) {
    const st = summarize(row.values[m] ?? []);
    if (st) stats[m] = st;
  }
  // A metric that never occurred (no loading UI, no payload on a back-button
  // step) is dropped rather than stored as a column of nulls.
  const values: Row['values'] = {};
  for (const m of METRICS) {
    if (stats[m]) values[m] = row.values[m];
  }
  return { ...row, values, stats };
}

/** Merge the same row from several runs: values pooled, stats recomputed. */
export function poolRows(runs: Row[][]): Row[] {
  const out = new Map<string, Row>();
  for (const rows of runs) {
    for (const r of rows) {
      const key = rowKey(r);
      const acc = out.get(key);
      if (!acc) {
        out.set(key, structuredClone(r));
        continue;
      }
      acc.n += r.n;
      for (const [k, v] of Object.entries(r.feedbackBy)) {
        acc.feedbackBy[k] = (acc.feedbackBy[k] ?? 0) + v;
      }
      for (const w of r.loadingUi) if (!acc.loadingUi.includes(w)) acc.loadingUi.push(w);
      for (const m of METRICS) {
        const add = r.values[m];
        if (add) (acc.values[m] ??= []).push(...add);
      }
    }
  }
  return [...out.values()].map(withStats);
}

// ─── First Load JS ─────────────────────────────────────────────────────────

export interface FirstLoadJs {
  route: string;
  files: number;
  /** gzip -9 of every chunk the route's first load needs; the old `next build` column. */
  gzipKB: number;
  rawKB: number;
}

/**
 * First Load JS per route, computed from the build output.
 *
 * Next 16 with Turbopack no longer prints the size table that older
 * `next build` output had: its route list has no size column (measured on
 * this repo's build, .perf/next-build.log). So the number is rebuilt from
 * what the build leaves behind:
 *
 *   .next/build-manifest.json            rootMainFiles, loaded on every route
 *   .next/server/app/<route>/page_client-reference-manifest.js
 *                                        entryJSFiles for each layout and page
 *                                        on the route
 *
 * It takes the union, excluding the not-found and global-error boundaries
 * (they load only when rendered) and the nomodule polyfills (a modern browser
 * skips them), and gzips each file, the way the old column was computed. The
 * harness cross-checks it against the script bytes a cold load of the entry
 * pages actually moved.
 */
export function firstLoadJs(nextDir = '.next'): FirstLoadJs[] {
  const bmPath = join(nextDir, 'build-manifest.json');
  const routesPath = join(nextDir, 'app-path-routes-manifest.json');
  if (!existsSync(bmPath) || !existsSync(routesPath)) return [];

  const root = (JSON.parse(readFileSync(bmPath, 'utf8')) as { rootMainFiles: string[] })
    .rootMainFiles;
  const routes = JSON.parse(readFileSync(routesPath, 'utf8')) as Record<string, string>;
  const sizeCache = new Map<string, { gz: number; raw: number }>();
  const size = (f: string) => {
    let s = sizeCache.get(f);
    if (!s) {
      const buf = readFileSync(join(nextDir, f.replace(/^\/?_next\//, '')));
      s = { gz: gzipSync(buf, { level: 9 }).length, raw: buf.length };
      sizeCache.set(f, s);
    }
    return s;
  };

  const out: FirstLoadJs[] = [];
  for (const [entry, route] of Object.entries(routes)) {
    if (!entry.endsWith('/page') || entry.startsWith('/_')) continue;
    const manifestPath = join(nextDir, 'server', 'app', `${entry}_client-reference-manifest.js`);
    if (!existsSync(manifestPath)) continue;
    // The manifest is a script that assigns to globalThis.__RSC_MANIFEST.
    // Inside a vm context, globalThis IS the sandbox.
    const sandbox: Record<string, unknown> = {};
    sandbox.self = sandbox;
    runInNewContext(readFileSync(manifestPath, 'utf8'), sandbox);
    const all = (sandbox.__RSC_MANIFEST ?? {}) as Record<
      string,
      { entryJSFiles?: Record<string, string[]> }
    >;
    const m = all[entry];
    if (!m?.entryJSFiles) continue;
    const files = new Set<string>(root);
    for (const [seg, chunks] of Object.entries(m.entryJSFiles)) {
      if (/not-found|global-error/.test(seg)) continue;
      for (const c of chunks) files.add(c);
    }
    let gz = 0;
    let raw = 0;
    for (const f of files) {
      const s = size(f);
      gz += s.gz;
      raw += s.raw;
    }
    out.push({ route, files: files.size, gzipKB: r1(gz / 1024), rawKB: r1(raw / 1024) });
  }
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

// ─── git ───────────────────────────────────────────────────────────────────

export interface GitInfo {
  head: string;
  /** The main commit this tree's app code is from: what the numbers describe. */
  base: string | null;
  branch: string;
  dirty: boolean;
}

const git = (...args: string[]) => {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
};

export function gitInfo(): GitInfo {
  const base = git('merge-base', 'HEAD', 'origin/main');
  return {
    head: git('rev-parse', '--short', 'HEAD'),
    base: base ? git('rev-parse', '--short', base) : null,
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    dirty: git('status', '--porcelain', '--untracked-files=no') !== '',
  };
}

// ─── Documents ─────────────────────────────────────────────────────────────

export interface RunDoc {
  schema: typeof RUN_SCHEMA;
  startedAt: string;
  finishedAt: string;
  /** Wall clock at the club when the run began; see seed-perf.ts on why it matters. */
  clubLocalStart: string;
  git: GitInfo;
  env: Record<string, unknown>;
  config: Record<string, unknown>;
  seed: Record<string, unknown> | null;
  /** `.next/BUILD_ID` of the build that was measured. */
  buildId: string | null;
  buildSkipped: boolean;
  failures: string[];
  /** Harness trouble that did not fail a test, such as a settle that timed out. */
  warnings: string[];
  firstLoadJs: FirstLoadJs[];
  rows: Row[];
  /** Every sample, in full. Kept in the local run file, dropped from a merged baseline. */
  samples?: Sample[];
}

export interface BaselineDoc {
  schema: typeof BASELINE_SCHEMA;
  createdAt: string;
  git: GitInfo;
  runs: Array<Omit<RunDoc, 'samples'>>;
  /** Every run's values pooled into one row per step. */
  pooled: Row[];
  /** Per row: the two runs' medians and how far apart they were. */
  variance: VarianceRow[];
  varianceSummary: Record<string, unknown>;
}

export interface VarianceRow {
  key: string;
  metric: 'tReady';
  medians: number[];
  absDelta: number;
  relDelta: number;
}

export function isBaseline(doc: RunDoc | BaselineDoc): doc is BaselineDoc {
  return doc.schema === BASELINE_SCHEMA;
}

/**
 * JSON with arrays of numbers kept on one line. Otherwise a baseline turns
 * into forty thousand lines of single numbers that nobody can read in a diff.
 * docs/perf/*.json is in .prettierignore for the same reason.
 */
export function stringify(doc: unknown): string {
  const json = JSON.stringify(doc, null, 2);
  return json.replace(
    /\[\s+((?:-?[\d.e+-]+|null)(?:,\s+(?:-?[\d.e+-]+|null))*)\s+\]/g,
    (_, inner: string) => `[${inner.replace(/\s+/g, ' ')}]`,
  );
}

// ─── Tables ────────────────────────────────────────────────────────────────

const fmtMs = (v: number | undefined) => (v == null ? '—' : `${Math.round(v)}`);
const fmtKB = (bytes: number | undefined) => (bytes == null ? '—' : (bytes / 1024).toFixed(1));

function label(r: Pick<Row, 'journey' | 'step' | 'kind'>): string {
  const tag = r.kind === 'hard' ? ' (full load)' : '';
  return `${r.journey} · ${r.step}${tag}`;
}

/** Row labels in first-seen order, across profiles and modes. */
function labels(rows: Row[]): Array<{ journey: string; step: string; kind: Row['kind'] }> {
  const seen = new Map<string, { journey: string; step: string; kind: Row['kind'] }>();
  for (const r of rows) {
    const k = `${r.journey}|${r.step}`;
    if (!seen.has(k)) seen.set(k, { journey: r.journey, step: r.step, kind: r.kind });
  }
  return [...seen.values()];
}

const find = (rows: Row[], journey: string, step: string, profile: string, mode: string) =>
  rows.find(
    (r) => r.journey === journey && r.step === step && r.profile === profile && r.mode === mode,
  );

/**
 * The headline: time until the destination's key content is painted,
 * median / p75 / p95 in ms, measured from the click.
 */
export function readyTable(rows: Row[]): string {
  const out = [
    '| Journey · step | Phone cold | Phone warm | Desktop cold | Desktop warm |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const l of labels(rows)) {
    const cell = (profile: string, mode: string) => {
      const st = find(rows, l.journey, l.step, profile, mode)?.stats.tReady;
      return st ? `${fmtMs(st.median)} / ${fmtMs(st.p75)} / ${fmtMs(st.p95)}` : '—';
    };
    out.push(
      `| ${label(l)} | ${cell('phone', 'cold')} | ${cell('phone', 'warm')} | ${cell('desktop', 'cold')} | ${cell('desktop', 'warm')} |`,
    );
  }
  return out.join('\n');
}

/**
 * What each navigation cost on the phone, cold: the requests it waited for
 * (started between the click and the commit of the destination), their
 * bytes, the RSC or HTML payload, when that payload's first and last bytes
 * arrived, and the first visible response.
 */
export function networkTable(rows: Row[], profile = 'phone', mode = 'cold'): string {
  const out = [
    `| Journey · step (${profile}, ${mode}) | Requests waited for | KB waited for | Payload KB (wire / decoded) | Payload first byte (ms) | Payload last byte (ms) | First feedback (ms) | Feedback came from |`,
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const l of labels(rows)) {
    const r = find(rows, l.journey, l.step, profile, mode);
    if (!r) continue;
    const s = r.stats;
    const payload =
      s.payloadTransfer || s.payloadDecoded
        ? `${fmtKB(s.payloadTransfer?.median)} / ${fmtKB(s.payloadDecoded?.median)}`
        : '—';
    const by = Object.entries(r.feedbackBy)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}/${r.n}`)
      .join(', ');
    out.push(
      `| ${label(l)} | ${fmtMs(s.requests?.median)} | ${fmtKB(s.bytes?.median)} | ${payload} | ${fmtMs(s.payloadTtfb?.median)} | ${fmtMs(s.payloadEnd?.median)} | ${fmtMs(s.tFeedback?.median)} | ${by} |`,
    );
  }
  return out.join('\n');
}

export function firstLoadTable(fl: FirstLoadJs[]): string {
  const out = [
    '| Route | First Load JS (gzip KB) | Raw KB | Chunks |',
    '| --- | ---: | ---: | ---: |',
  ];
  for (const f of fl) out.push(`| \`${f.route}\` | ${f.gzipKB} | ${f.rawKB} | ${f.files} |`);
  return out.join('\n');
}
