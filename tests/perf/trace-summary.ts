import { readFileSync } from 'node:fs';

/**
 * Where a traced full load's time went before its first paint (#601).
 *
 *   PERF_TRACE=landing-staff npm run perf:nav -- --grep "landing-staff · run" --project=perf-phone
 *   npm run perf:trace -- .perf/traces/landing-staff-phone-warm-run1.json [more.json …]
 *
 * For each trace: from the final document's navigationStart to its
 * firstContentfulPaint, how much of that the page's main thread was busy, on
 * what (parsing HTML, scripts, styles, layout, paint), and which requests were
 * sent before the paint, the render-blocking ones marked. Two files print side
 * by side in the same order, so a slower build's extra work stands out.
 */

type TraceEvent = {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { name?: string; data?: Record<string, unknown>; frame?: string };
};

/** Work on the main thread, grouped as Chrome's Performance panel groups it. */
const KINDS: Record<string, string> = {
  ParseHTML: 'parse HTML',
  ParseAuthorStyleSheet: 'parse CSS',
  EvaluateScript: 'run scripts',
  'v8.compile': 'compile scripts',
  'v8.compileModule': 'compile scripts',
  'v8.produceCache': 'compile scripts',
  FunctionCall: 'run scripts',
  RunMicrotasks: 'run scripts',
  TimerFire: 'run scripts',
  EventDispatch: 'run scripts',
  UpdateLayoutTree: 'style',
  Layout: 'layout',
  PrePaint: 'paint',
  Paint: 'paint',
  Layerize: 'paint',
  Commit: 'paint',
};

function summarize(file: string) {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as
    TraceEvent[] | { traceEvents: TraceEvent[] };
  const events = Array.isArray(raw) ? raw : raw.traceEvents;

  const fcp = events
    .filter((e) => e.name === 'firstContentfulPaint')
    .sort((a, b) => a.ts - b.ts)[0];
  if (!fcp) return { file, error: 'no firstContentfulPaint in the trace' };
  const nav = events
    .filter(
      (e) =>
        e.name === 'navigationStart' &&
        e.pid === fcp.pid &&
        e.ts <= fcp.ts &&
        (e.args?.data as { isLoadingMainFrame?: boolean } | undefined)?.isLoadingMainFrame !==
          false,
    )
    .sort((a, b) => b.ts - a.ts)[0];
  if (!nav) return { file, error: 'no navigationStart before the paint' };

  const main = new Set(
    events
      .filter(
        (e) =>
          e.ph === 'M' &&
          e.name === 'thread_name' &&
          e.args?.name === 'CrRendererMain' &&
          e.pid === fcp.pid,
      )
      .map((e) => e.tid),
  );
  const onMain = (e: TraceEvent) =>
    e.pid === fcp.pid && main.has(e.tid) && e.ph === 'X' && e.dur != null;
  const within = (e: TraceEvent) =>
    Math.max(0, Math.min(e.ts + e.dur!, fcp.ts) - Math.max(e.ts, nav.ts));

  const busy = events
    .filter((e) => onMain(e) && e.name === 'RunTask')
    .reduce((sum, e) => sum + within(e), 0);
  const byKind = new Map<string, number>();
  for (const e of events) {
    const kind = KINDS[e.name];
    if (kind && onMain(e)) byKind.set(kind, (byKind.get(kind) ?? 0) + within(e));
  }

  const sent = events
    .filter((e) => e.name === 'ResourceSendRequest' && e.ts >= nav.ts && e.ts <= fcp.ts)
    .map((e) => {
      const d = (e.args?.data ?? {}) as {
        url?: string;
        renderBlocking?: string;
        priority?: string;
      };
      const url = new URL(d.url ?? 'about:blank');
      return {
        at: Math.round((e.ts - nav.ts) / 1000),
        what: `${url.pathname}${url.search}`.slice(0, 90),
        blocking: d.renderBlocking === 'blocking' || d.renderBlocking === 'in_body_parser_blocking',
      };
    });

  return {
    file,
    fcpMs: Math.round((fcp.ts - nav.ts) / 1000),
    busyMs: Math.round(busy / 1000),
    byKind: [...byKind]
      .sort((a, b) => b[1] - a[1])
      .map(([k, us]) => [k, Math.round(us / 1000)] as const),
    sent,
  };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('Usage: npm run perf:trace -- <trace.json> [more.json …]\n');
  process.exit(2);
}
for (const s of files.map(summarize)) {
  process.stdout.write(`\n══ ${s.file}\n`);
  if ('error' in s) {
    process.stdout.write(`   ${s.error}\n`);
    continue;
  }
  process.stdout.write(
    `   first contentful paint ${s.fcpMs} ms after navigationStart; main thread busy ${s.busyMs} ms of it\n`,
  );
  for (const [kind, ms] of s.byKind)
    process.stdout.write(`     ${kind.padEnd(16)} ${String(ms).padStart(5)} ms\n`);
  process.stdout.write(
    `   ${s.sent.length} requests sent before the paint (${s.sent.filter((r) => r.blocking).length} render-blocking):\n`,
  );
  for (const r of s.sent)
    process.stdout.write(
      `     ${String(r.at).padStart(5)} ms ${r.blocking ? 'BLOCKING ' : '         '}${r.what}\n`,
    );
}
