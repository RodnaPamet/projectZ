import { loadavg } from 'node:os';

import type { Browser, BrowserContext, CDPSession, Page } from '@playwright/test';

import {
  FEEDBACK_SELECTOR,
  installPerfAgent,
  type EntryRecord,
  type PerfAgent,
  type ReadyTable,
  type StepRecord,
} from './agent';
import {
  authStatePath,
  PERF_BASE_URL,
  QUIET_MS,
  SETTLE_TIMEOUT_MS,
  STEP_TIMEOUT_MS,
  type PerfProfile,
  type PersonaId,
} from './config';

/**
 * The Node half of the harness: one fresh, throttled browser context per
 * session, with a network recorder and the in-page agent. A session measures
 * two kinds of thing.
 *
 *   enter(path)   a full page load (goto). Only ever the ENTRY page of a
 *                 journey, and the post-sign-in landing, which really is a
 *                 full load.
 *   step(...)     a click on a real link (or a tap, on the phone), or the back
 *                 button: what a person actually does.
 */

export type Mode = 'cold' | 'warm';

type Kind =
  | 'document'
  | 'rsc'
  | 'rsc-prefetch'
  | 'action'
  | 'script'
  | 'style'
  | 'font'
  | 'image'
  | 'fetch'
  | 'other';

interface NetRecord {
  url: string;
  kind: Kind;
  status: number | null;
  /** Epoch ms, from CDP's wall clock, the same clock as `performance.timeOrigin`. */
  start: number;
  ttfb: number | null;
  /** null while the body is still open (see NetRecorder on zombie prefetches). */
  end: number | null;
  /** Encoded bytes: the response headers, then each body chunk as it streamed in. */
  headerBytes: number;
  streamedBytes: number;
  /** The total CDP reports once the body is complete, headers included. Authoritative. */
  finishedBytes: number | null;
  /** Decoded body bytes, counted from the chunks as they arrived. */
  decoded: number;
  failed: boolean;
  fromCache: boolean;
}

/** What crossed the (emulated) network for one request, headers included. */
const transferOf = (r: NetRecord) => r.finishedBytes ?? r.headerBytes + r.streamedBytes;

/** A Resource Timing entry, with its start converted to epoch ms. */
interface ResourceEntry {
  name: string;
  start: number;
  transferSize: number;
}

/** The slice of CDP's Network events this recorder reads. */
interface CdpRequest {
  requestId: string;
  timestamp: number;
  wallTime: number;
  type?: string;
  request: { url: string; method: string; headers: Record<string, string> };
  redirectResponse?: { status: number; encodedDataLength: number };
}
interface CdpResponse {
  requestId: string;
  timestamp: number;
  response: {
    status: number;
    encodedDataLength: number;
    fromDiskCache?: boolean;
    timing?: { requestTime: number; receiveHeadersEnd: number };
  };
}

function classify(type: string | undefined, method: string, headers: Record<string, string>): Kind {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (method === 'POST' && h['next-action']) return 'action';
  if (h['rsc'] === '1') {
    return h['next-router-prefetch'] || h['next-router-segment-prefetch'] ? 'rsc-prefetch' : 'rsc';
  }
  switch (type) {
    case 'Document':
      return 'document';
    case 'Script':
      return 'script';
    case 'Stylesheet':
      return 'style';
    case 'Font':
      return 'font';
    case 'Image':
      return 'image';
    case 'Fetch':
    case 'XHR':
      return 'fetch';
    default:
      return 'other';
  }
}

/**
 * Every request the page makes, from CDP's own Network events.
 *
 * ═══ WHY NOT PLAYWRIGHT'S request/requestfinished ═══
 *
 * Because some requests never finish. Every venue card on /venues links to
 * `/venues/{slug}`, a page that does not exist. Next prefetches each card as
 * it scrolls into view, the server answers 404 in 2 ms, and Chrome then never
 * reports the request as finished or failed: measured, not one of the eleven
 * got `loadingFinished` in eight seconds. Presumably the router holds the
 * response and never reads its body. "Wait until nothing is in flight" then
 * waited twenty seconds after every visit to /venues.
 *
 * So "quiet" means no request is still waiting for its response headers, and
 * nothing at all has happened on the network for QUIET_MS. A response whose
 * body nobody reads is not in flight, and is still counted, as the request it
 * was.
 */
class NetRecorder {
  readonly records: NetRecord[] = [];
  private readonly byId = new Map<string, NetRecord>();
  private readonly awaitingHeaders = new Map<string, string>();
  /** CDP timestamps are monotonic seconds; wallTime maps them onto the epoch. */
  private offsetMs = 0;
  lastActivity = Date.now();

  constructor(cdp: CDPSession) {
    const touch = () => {
      this.lastActivity = Date.now();
    };
    const epoch = (ts: number) => ts * 1000 + this.offsetMs;

    cdp.on('Network.requestWillBeSent', (e: CdpRequest) => {
      touch();
      this.offsetMs = e.wallTime * 1000 - e.timestamp * 1000;
      const prev = this.byId.get(e.requestId);
      if (prev && e.redirectResponse) {
        // A redirect ends one hop and begins the next under the same id.
        prev.status = e.redirectResponse.status;
        prev.finishedBytes = e.redirectResponse.encodedDataLength;
        prev.end = epoch(e.timestamp);
      }
      const rec: NetRecord = {
        url: e.request.url,
        kind: classify(e.type, e.request.method, e.request.headers),
        status: null,
        start: epoch(e.timestamp),
        ttfb: null,
        end: null,
        headerBytes: 0,
        streamedBytes: 0,
        finishedBytes: null,
        decoded: 0,
        failed: false,
        fromCache: false,
      };
      this.records.push(rec);
      this.byId.set(e.requestId, rec);
      this.awaitingHeaders.set(e.requestId, `${e.request.method} ${e.request.url}`);
    });
    cdp.on('Network.requestServedFromCache', (e: { requestId: string }) => {
      const rec = this.byId.get(e.requestId);
      if (rec) rec.fromCache = true;
    });
    cdp.on('Network.responseReceived', (e: CdpResponse) => {
      touch();
      this.awaitingHeaders.delete(e.requestId);
      const rec = this.byId.get(e.requestId);
      if (!rec) return;
      rec.status = e.response.status;
      rec.headerBytes = e.response.encodedDataLength;
      rec.fromCache ||= !!e.response.fromDiskCache;
      const t = e.response.timing;
      rec.ttfb = t ? epoch(t.requestTime + t.receiveHeadersEnd / 1000) : epoch(e.timestamp);
    });
    cdp.on(
      'Network.dataReceived',
      (e: { requestId: string; dataLength: number; encodedDataLength: number }) => {
        touch();
        const rec = this.byId.get(e.requestId);
        if (!rec) return;
        rec.decoded += e.dataLength;
        rec.streamedBytes += e.encodedDataLength;
      },
    );
    cdp.on(
      'Network.loadingFinished',
      (e: { requestId: string; timestamp: number; encodedDataLength: number }) => {
        touch();
        this.awaitingHeaders.delete(e.requestId);
        const rec = this.byId.get(e.requestId);
        if (!rec) return;
        rec.end = epoch(e.timestamp);
        rec.finishedBytes = e.encodedDataLength;
      },
    );
    cdp.on('Network.loadingFailed', (e: { requestId: string; timestamp: number }) => {
      touch();
      this.awaitingHeaders.delete(e.requestId);
      const rec = this.byId.get(e.requestId);
      if (!rec) return;
      rec.failed = true;
      rec.end = epoch(e.timestamp);
    });
  }

  /** Requests still waiting for their response headers. */
  get busy(): number {
    return this.awaitingHeaders.size;
  }

  get busyUrls(): string[] {
    return [...this.awaitingHeaders.values()];
  }

  /** Requests that STARTED in [from, to], epoch ms. */
  between(from: number, to: number): NetRecord[] {
    return this.records.filter((r) => r.start >= from && r.start <= to);
  }

  /**
   * Fill in sizes CDP never completed, from the page's own Resource Timing.
   *
   * The router reads an RSC response to its end and then cancels the fetch.
   * CDP then reports the request as failed, without the `loadingFinished`
   * total, and the body chunks it did report undercount the wire bytes (a
   * 19 KB diary payload showed 1.5 KB). Resource Timing's `transferSize` is
   * the renderer's own count of the same bytes, so a request that CDP left
   * open takes its size from there.
   */
  reconcile(entries: ResourceEntry[]) {
    for (const r of this.records) {
      if (r.finishedBytes != null || r.status !== 200) continue;
      // The same URL recurs (a warm pass fetches the same RSC again), so the
      // entry is matched on start time as well: the closest, within 50 ms.
      let best: ResourceEntry | null = null;
      for (const e of entries) {
        if (e.name !== r.url || e.transferSize <= 0) continue;
        const gap = Math.abs(e.start - r.start);
        if (gap <= 50 && (!best || gap < Math.abs(best.start - r.start))) best = e;
      }
      if (best) r.finishedBytes = best.transferSize;
    }
  }
}

/** One measured navigation. Everything in ms is measured from the trigger (t0). */
export interface Sample {
  journey: string;
  step: string;
  profile: PerfProfile['id'];
  mode: Mode;
  run: number;
  pass: number;
  /** soft = client-side (RSC) navigation; hard = full document load; history = back button. */
  kind: 'soft' | 'hard' | 'history';
  trigger: string;
  from: string;
  to: string;

  /** Earliest visible response: the URL changing, loading UI appearing, or (hard) first paint. */
  tFeedback: number | null;
  feedbackBy: 'url' | 'loading-ui' | 'fcp' | null;
  tUrl: number | null;
  tLoadingUi: number | null;
  loadingUiWhat: string | null;
  /** The destination's key content is painted. */
  tReady: number;

  /**
   * Requests started between t0 and the commit of the destination (the
   * navigation waited for these), and the bytes they moved.
   */
  requests: number;
  bytes: number;
  /** Requests started after that commit, until the network went quiet (prefetch, lazy chunks). */
  trailingRequests: number;
  trailingBytes: number;
  /** Next.js prefetch requests the ORIGIN page made between its own arrival and this click. */
  prefetchesBefore: number;
  prefetchBytesBefore: number;
  jsRequests: number;
  jsBytes: number;

  /** The navigation's own payload: the RSC response (soft) or the final HTML (hard). */
  payload: {
    kind: 'rsc' | 'html' | null;
    transfer: number | null;
    decoded: number | null;
    /** ms from t0 to its first byte, and to its last. */
    ttfb: number | null;
    end: number | null;
  };

  /** Full loads only. */
  hard?: {
    redirects: number;
    redirectMs: number | null;
    fcp: number | null;
    lcp: number | null;
    domContentLoaded: number | null;
    load: number | null;
  };

  loadavg1: number;
  at: string;
}

type NavTiming = {
  redirectCount: number;
  redirectStart: number;
  redirectEnd: number;
  domContentLoadedEventEnd: number;
  loadEventEnd: number;
};

/** PERF_DEBUG=1 prints where each step's wall time goes, for working on the harness itself. */
const debug = (msg: string) => {
  if (process.env.PERF_DEBUG === '1') process.stdout.write(`[perf:debug] ${msg}\n`);
};

export class PerfSession {
  private lastMark: number;
  readonly samples: Sample[] = [];
  readonly warnings: string[] = [];

  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    readonly cdp: CDPSession,
    readonly rec: NetRecorder,
    readonly profile: PerfProfile,
    readonly journey: string,
    readonly run: number,
    readonly browserVersion: string,
  ) {
    this.lastMark = Date.now();
  }

  static async open(opts: {
    browser: Browser;
    profile: PerfProfile;
    persona: PersonaId | null;
    journey: string;
    run: number;
    table: ReadyTable;
  }): Promise<PerfSession> {
    const { browser, profile, persona } = opts;
    // A FRESH context: empty HTTP cache, no router cache, no JS in memory.
    // Signed in (if a persona) from the state global-setup saved. Bulgarian
    // and in Sofia, like the people it is for.
    const context = await browser.newContext({
      ...profile.device,
      baseURL: PERF_BASE_URL,
      storageState: persona ? authStatePath(persona) : undefined,
      locale: 'bg-BG',
      timezoneId: 'Europe/Sofia',
    });
    const page = await context.newPage();
    await page.addInitScript(installPerfAgent, {
      table: opts.table,
      feedback: FEEDBACK_SELECTOR,
    });

    // Recording and throttling through CDP, both in place before the first
    // byte is requested.
    const cdp = await context.newCDPSession(page);
    const rec = new NetRecorder(cdp);
    await cdp.send('Network.enable');
    if (profile.cpuThrottlingRate > 1) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuThrottlingRate });
    }
    if (profile.network) {
      await cdp.send('Network.emulateNetworkConditions', profile.network);
    }

    return new PerfSession(
      context,
      page,
      cdp,
      rec,
      profile,
      opts.journey,
      opts.run,
      browser.version(),
    );
  }

  async close() {
    await this.context.close();
  }

  /**
   * Wait until the page has finished what it started: no request in flight
   * for QUIET_MS, and then an idle main thread. Each click happens from the
   * same kind of state, whether the previous step was fast or slow.
   *
   * A real person does not wait for the network to go quiet. The cost of
   * clicking early (racing an unfinished prefetch or hydration) is real, but
   * it would make every sample a different race. What this measures is the
   * settled case, and the README says so.
   */
  async settle(why = '') {
    const t = Date.now();
    const deadline = t + SETTLE_TIMEOUT_MS;
    let quiet = false;
    while (Date.now() < deadline) {
      if (this.rec.busy === 0 && Date.now() - this.rec.lastActivity >= QUIET_MS) {
        quiet = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!quiet) {
      // Something never finished. Say what, rather than wait silently on
      // every step: a settle that times out is 20 s of nothing per click.
      this.warnings.push(`settle(${why}) timed out with ${this.rec.busyUrls.join(', ')}`);
    }
    // Then an idle main thread, and the page's Resource Timing while we are
    // there (see NetRecorder.reconcile).
    const entries = await this.page.evaluate(
      () =>
        new Promise<ResourceEntry[]>((r) =>
          requestIdleCallback(
            () =>
              r(
                performance.getEntriesByType('resource').map((e) => ({
                  name: e.name,
                  start: performance.timeOrigin + e.startTime,
                  transferSize: (e as PerformanceResourceTiming).transferSize,
                })),
              ),
            { timeout: 2000 },
          ),
        ),
    );
    this.rec.reconcile(entries);
    debug(
      `settle(${why}) ${Date.now() - t}ms${quiet ? '' : ` TIMED OUT: ${this.rec.busyUrls.join(', ')}`}`,
    );
  }

  /**
   * A finger on the link: touchstart, touchend, and the click the browser
   * makes of them. Next's <Link> starts a prefetch on touchstart, as it
   * does on a real phone.
   *
   * ═══ WHY NOT locator.tap() ═══
   *
   * On a phone the club shell is WIDER than the screen. The admin nav
   * measures 934 px on a 393 px Pixel 5, so the layout viewport grows to
   * 934 px and the visual viewport shows its left edge. Playwright's tap
   * then aims at the wrong point: it reported "<a …/coaches> intercepts
   * pointer events" and retried until the test timed out. The point is
   * therefore computed here, in the page, from the link's own box and the
   * visual viewport, and hit-tested before anything is sent. If something
   * else covers the link, the step fails and says so.
   */
  private async tap(selector: string) {
    const p = await this.page.evaluate((sel) => {
      const el = document.querySelector(sel)!;
      const r = el.getBoundingClientRect();
      const v = window.visualViewport!;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      return {
        x: (cx - v.offsetLeft) * v.scale,
        y: (cy - v.offsetTop) * v.scale,
        covered:
          !hit || !(hit === el || el.contains(hit))
            ? (hit?.outerHTML ?? 'nothing').slice(0, 160)
            : null,
      };
    }, selector);
    if (p.covered) throw new Error(`cannot tap ${selector}: its centre is covered by ${p.covered}`);
    await this.page.touchscreen.tap(p.x, p.y);
  }

  private prefetchSince(epoch: number, until: number) {
    const pre = this.rec.between(epoch, until).filter((r) => r.kind === 'rsc-prefetch');
    return { n: pre.length, bytes: sum(pre) };
  }

  /**
   * A full page load: the entry page of a journey, or the post-sign-in
   * landing. `key` is the URL the load is expected to END on, after any
   * redirects.
   */
  async enter(opts: { path: string; key: string; step: string; mode: Mode; pass: number }) {
    const started = Date.now();
    await this.page.goto(opts.path, { waitUntil: 'commit', timeout: STEP_TIMEOUT_MS });
    await this.page.waitForFunction(
      () => (window as unknown as { __perf?: PerfAgent }).__perf?.entry.readyAt != null,
      null,
      { timeout: STEP_TIMEOUT_MS, polling: 100 },
    );
    const got = await this.page.evaluate(() => {
      const a = (window as unknown as { __perf: PerfAgent }).__perf;
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      return {
        entry: a.entry as EntryRecord,
        href: location.pathname + location.search,
        nav: {
          redirectCount: nav.redirectCount,
          redirectStart: nav.redirectStart,
          redirectEnd: nav.redirectEnd,
          domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
          loadEventEnd: nav.loadEventEnd,
        } as NavTiming,
      };
    });
    if (got.href !== opts.key) {
      throw new Error(`${opts.path} ended on ${got.href}, expected ${opts.key}`);
    }
    debug(
      `enter ${opts.path}: ready at ${Math.round(got.entry.readyAt!)}ms (wall ${Date.now() - started}ms)`,
    );
    await this.settle('after load');
    // Read again once settled: the paint observers report in their own tasks,
    // which can land after the agent's ready callback.
    const late = await this.page.evaluate(() => {
      const a = (window as unknown as { __perf: PerfAgent }).__perf;
      const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      return {
        fcp: a.entry.fcp,
        lcp: a.entry.lcp,
        dcl: n.domContentLoadedEventEnd,
        load: n.loadEventEnd,
      };
    });
    got.entry.fcp = late.fcp;
    got.entry.lcp = late.lcp;
    const nav = { dcl: late.dcl, load: late.load };

    // The content can be in the DOM, and even laid out, before the first
    // paint: a render-blocking stylesheet holds the paint back (measured: the
    // Google Fonts stylesheet does exactly this). Nothing is visible before
    // first-contentful-paint, so a full load is ready at the later of the two.
    const readyAt = Math.max(got.entry.readyAt!, got.entry.fcp ?? 0);
    const t0 = got.entry.timeOrigin;
    const ready = t0 + readyAt;
    // Navigation start can precede the Node-side timestamp by a hair; take the earlier.
    const from = Math.min(t0, started) - 1;
    const upToReady = this.rec.between(from, ready);
    const trailing = this.rec.between(ready + 0.001, Date.now());
    const docs = [...upToReady].filter((r) => r.kind === 'document');
    const html = docs[docs.length - 1] ?? null;
    const js = [...upToReady, ...trailing].filter((r) => r.kind === 'script');

    this.push({
      step: opts.step,
      mode: opts.mode,
      pass: opts.pass,
      kind: 'hard',
      trigger: 'goto',
      from: 'about:blank',
      to: opts.key,
      tFeedback: got.entry.fcp,
      feedbackBy: got.entry.fcp != null ? 'fcp' : null,
      tUrl: html?.ttfb != null ? html.ttfb - t0 : null,
      tLoadingUi: null,
      loadingUiWhat: null,
      tReady: readyAt,
      requests: upToReady.length,
      bytes: sum(upToReady),
      trailingRequests: trailing.length,
      trailingBytes: sum(trailing),
      prefetchesBefore: 0,
      prefetchBytesBefore: 0,
      jsRequests: js.length,
      jsBytes: sum(js),
      payload: {
        kind: html ? 'html' : null,
        transfer: html ? transferOf(html) : null,
        decoded: html?.decoded ?? null,
        ttfb: html?.ttfb != null ? html.ttfb - t0 : null,
        end: html?.end != null ? html.end - t0 : null,
      },
      hard: {
        redirects: got.nav.redirectCount,
        redirectMs: got.nav.redirectCount > 0 ? got.nav.redirectEnd - got.nav.redirectStart : null,
        fcp: got.entry.fcp,
        lcp: got.entry.lcp,
        domContentLoaded: nav.dcl || null,
        load: nav.load || null,
      },
    });
    this.lastMark = ready;
  }

  /**
   * One navigation by a real input: a click on the desktop, a tap on the
   * phone, or the back button. `key` is the destination (pathname + search).
   */
  async step(opts: {
    step: string;
    key: string;
    mode: Mode;
    pass: number;
    click?: string;
    back?: boolean;
  }) {
    const t = Date.now();
    await this.settle('before');

    let target = null;
    if (opts.click) {
      target = this.page.locator(opts.click);
      // A click before hydration is a full page load, not a navigation.
      // settle() makes this nearly always true already; this makes it certain.
      await target.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
      await this.page.waitForFunction(
        (sel) => {
          const el = document.querySelector(sel);
          return !!el && Object.keys(el).some((k) => k.startsWith('__reactProps$'));
        },
        opts.click,
        { timeout: STEP_TIMEOUT_MS },
      );
      debug(`${opts.step}: target hydrated after ${Date.now() - t}ms`);
      // Scrolling the link into view is the person's thumb, not the
      // navigation. Done first, so viewport-entry prefetch starts where it
      // would for them, and then the network is allowed to go quiet again.
      await target.evaluate((el) => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
      await this.settle('after scroll');
    }

    const armed = await this.page.evaluate(
      (key) => (window as unknown as { __perf: PerfAgent }).__perf.arm(key),
      opts.key,
    );
    if (armed) throw new Error(`${opts.step}: ${armed}`);

    const from = new URL(this.page.url()).pathname;
    const tClick = Date.now();
    if (target && this.profile.input === 'tap') {
      await this.tap(opts.click!);
    } else if (target) {
      await target.click();
    } else if (opts.back) {
      await this.page.evaluate(() => (window as unknown as { __perf: PerfAgent }).__perf.back());
    }
    debug(`${opts.step}: input dispatched in ${Date.now() - tClick}ms`);

    // If the click fell back to a full page load, the agent that recorded t0 is
    // gone, and waiting on it would only time out. Say so instead.
    const done = await this.page.waitForFunction(
      () => {
        const a = (window as unknown as { __perf?: PerfAgent }).__perf;
        if (!a) return null;
        if (a.step?.readyAt != null) return 'soft';
        if (a.entry.clickEpoch != null && a.entry.readyAt != null) return 'hard';
        return null;
      },
      null,
      { timeout: STEP_TIMEOUT_MS, polling: 100 },
    );
    const how = (await done.jsonValue()) as 'soft' | 'hard';
    if (how === 'hard') {
      throw new Error(
        `${opts.step}: the click caused a FULL PAGE LOAD, not a client-side navigation. ` +
          `That is a regression in itself; the harness does not time it as a navigation.`,
      );
    }

    const s = (await this.page.evaluate(
      () => (window as unknown as { __perf: PerfAgent }).__perf.step,
    )) as StepRecord;
    if (s.t0 == null) throw new Error(`${opts.step}: no click reached the page`);
    debug(
      `${opts.step}: ready ${Math.round(s.readyAt! - s.t0)}ms after the click (wall ${Date.now() - tClick}ms)`,
    );

    await this.settle('after');
    debug(`${opts.step}: whole step ${Date.now() - t}ms`);

    const t0 = s.timeOrigin + s.t0;
    const ready = s.timeOrigin + s.readyAt!;
    // What the navigation WAITED for: requests started between the click and
    // the commit that put the destination in the DOM. Links on the new page
    // begin prefetching as that commit mounts them, a millisecond or two
    // later, and those belong to "trailing": they were not waited for.
    // The 2 ms before t0 is for the two clocks (CDP wall time and
    // performance.timeOrigin) disagreeing; a request cannot start before the
    // click that caused it.
    const committed = s.timeOrigin + s.readyDomAt!;
    const blocking = this.rec.between(t0 - 2, committed);
    const trailing = this.rec.between(committed + 0.001, Date.now());
    const before = this.prefetchSince(this.lastMark, t0 - 2);
    const rsc = blocking.find((r) => r.kind === 'rsc') ?? null;
    const js = [...blocking, ...trailing].filter((r) => r.kind === 'script');
    for (const r of [...blocking, ...trailing]) {
      debug(
        `  ${r.start <= committed ? 'wait' : 'tail'} ${r.kind.padEnd(12)} ${String(r.status).padEnd(4)} ` +
          `start+${Math.round(r.start - t0)} ttfb+${r.ttfb == null ? '-' : Math.round(r.ttfb - t0)} ` +
          `end+${r.end == null ? '-' : Math.round(r.end - t0)} ${transferOf(r)}B/${r.decoded}B ` +
          `(hdr ${r.headerBytes}, streamed ${r.streamedBytes}, finished ${r.finishedBytes ?? '-'}) ` +
          `${r.url.replace(PERF_BASE_URL, '').slice(0, 90)}`,
      );
    }

    const rel = (v: number | null) => (v == null ? null : v - s.t0!);
    const tUrl = rel(s.urlAt);
    const tLoadingUi = rel(s.loadingUiAt);
    const firsts: Array<[number, 'url' | 'loading-ui']> = [];
    if (tUrl != null) firsts.push([tUrl, 'url']);
    if (tLoadingUi != null) firsts.push([tLoadingUi, 'loading-ui']);
    firsts.sort((a, b) => a[0] - b[0]);

    this.push({
      step: opts.step,
      mode: opts.mode,
      pass: opts.pass,
      kind: opts.back ? 'history' : 'soft',
      trigger: s.trigger ?? (opts.back ? 'history-back' : this.profile.input),
      from,
      to: opts.key,
      tFeedback: firsts[0]?.[0] ?? null,
      feedbackBy: firsts[0]?.[1] ?? null,
      tUrl,
      tLoadingUi,
      loadingUiWhat: s.loadingUiWhat,
      tReady: s.readyAt! - s.t0,
      requests: blocking.length,
      bytes: sum(blocking),
      trailingRequests: trailing.length,
      trailingBytes: sum(trailing),
      prefetchesBefore: before.n,
      prefetchBytesBefore: before.bytes,
      jsRequests: js.length,
      jsBytes: sum(js),
      payload: {
        kind: rsc ? 'rsc' : null,
        transfer: rsc ? transferOf(rsc) : null,
        decoded: rsc?.decoded ?? null,
        ttfb: rsc?.ttfb != null ? rsc.ttfb - t0 : null,
        end: rsc?.end != null ? rsc.end - t0 : null,
      },
    });
    this.lastMark = ready;
  }

  private push(s: Omit<Sample, 'journey' | 'profile' | 'run' | 'loadavg1' | 'at'>) {
    this.samples.push({
      journey: this.journey,
      profile: this.profile.id,
      run: this.run,
      loadavg1: Math.round(loadavg()[0]! * 100) / 100,
      at: new Date().toISOString(),
      ...s,
    });
  }
}

function sum(rs: NetRecord[]): number {
  return rs.reduce((s, r) => s + transferOf(r), 0);
}
