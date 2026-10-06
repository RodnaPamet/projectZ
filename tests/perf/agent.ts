/**
 * The in-page half of the harness. It is serialised into every document the
 * page loads (`page.addInitScript`), before any app script runs. So it must
 * stay self-contained: no imports, and no references to anything outside the
 * function body.
 *
 * ═══ WHY THE CLOCK LIVES IN THE PAGE ═══
 *
 * inflect-compliance measured navigation with `useReportWebVitals`, which
 * cannot see an App Router navigation at all: a soft navigation has no LCP, no
 * FCP and no navigation entry. Timing from the test runner instead would add
 * a CDP round trip, plus Playwright's polling interval, to every number.
 *
 * So each timestamp here is `performance.now()`, taken in the page, at the
 * moment the thing happened:
 *
 *   t0          the click's own `event.timeStamp`, read by a CAPTURING listener
 *               on window. It runs before React's root listener, so before
 *               Next's <Link> has started anything, and the event's timestamp
 *               also covers any input delay before that.
 *   urlAt       the Navigation API's `currententrychange`, which fires on the
 *               router's pushState.
 *   loadingUiAt the first NEW visible element matching FEEDBACK_SELECTOR.
 *   firstAt     the destination's FIRST CONTENT is painted: the part of the
 *               page that can show before its slowest data (the venue page's
 *               header, before its slots; #403). Optional per destination
 *               (FirstTable), and timed after the next paint like readyAt.
 *   readyAt     the destination's ready conditions all hold. The time is
 *               taken after the NEXT PAINT (a task posted from rAF runs after
 *               that frame's rendering), because "visible" means painted and
 *               not merely inserted. Under ×4 CPU, style, layout and paint of
 *               a long list are part of the wait, and so part of the number.
 *
 * Detection runs on a MutationObserver, which fires within the microtask of
 * the commit, backed by a rAF loop for changes that are not mutations.
 */

export interface ReadyCondition {
  /** CSS selector. At least one match must be visible (non-zero box, not hidden). */
  selector: string;
  /** If set, that visible match's textContent must contain it. */
  text?: string;
}

/** Destination → what "its key content is visible" means. Keyed by pathname + search. */
export type ReadyTable = Record<string, ReadyCondition[]>;

/**
 * Destination → what "its first content is visible" means, for a page that
 * paints in two stages. Keyed by PATHNAME only: the venue page mirrors its day
 * into the query string as its booking panel mounts, which is after the header
 * it is timing has painted.
 */
export type FirstTable = Record<string, ReadyCondition[]>;

export interface StepRecord {
  key: string;
  from: string;
  t0: number | null;
  trigger: string | null;
  urlAt: number | null;
  loadingUiAt: number | null;
  loadingUiWhat: string | null;
  firstAt: number | null;
  readyDomAt: number | null;
  readyAt: number | null;
  timeOrigin: number;
}

export interface EntryRecord {
  key: string;
  readyDomAt: number | null;
  readyAt: number | null;
  fcp: number | null;
  lcp: number | null;
  timeOrigin: number;
  /** Set when a click in the PREVIOUS document led here by a full page load. */
  clickEpoch: number | null;
}

export interface PerfAgent {
  step: StepRecord | null;
  entry: EntryRecord;
  arm(key: string): string | null;
  back(): void;
}

/**
 * What counts as loading UI. Each entry is here because something in this
 * repo, or something about to arrive, renders it:
 *
 *   [role=progressbar]           a progress bar (react-transition-progress,
 *                                nprogress, a useLinkStatus hint done right)
 *   [aria-busy=true] on a non-button
 *                                the design system's page skeletons
 *                                (SkeletonDashboard & co. in
 *                                components/ui/skeleton.tsx) set it on their
 *                                container
 *   [class*=shimmer], [class*=animate-pulse], [class*=animate-spin],
 *   .loading-spinner, [data-skeleton-table]
 *                                the skeleton and spinner primitives themselves
 *   [data-loading], [data-perf-feedback]
 *                                an explicit opt-in, for UI that fits none of
 *                                the above
 *
 * `aria-busy` on a BUTTON is excluded on purpose. A busy button changes
 * nothing on screen (the role switcher, removed in #263, did exactly that
 * while its action ran). A screen-reader hint is not visible feedback, and
 * counting it would report such a control as instant.
 */
export const FEEDBACK_SELECTOR = [
  '[role="progressbar"]',
  '[aria-busy="true"]:not(button):not([role="button"])',
  '[class*="shimmer"]',
  '[class*="animate-pulse"]',
  '[class*="animate-spin"]',
  '.loading-spinner',
  '[data-skeleton-table]',
  '[data-loading]',
  '[data-perf-feedback]',
].join(',');

export function installPerfAgent(args: {
  table: ReadyTable;
  first: FirstTable;
  feedback: string;
}): void {
  const w = window as unknown as { __perf?: PerfAgent };
  if (w.__perf) return;

  const { table, first, feedback } = args;
  const now = () => performance.now();
  // The harness reads Resource Timing for sizes CDP leaves open, and a whole
  // loop of navigations outgrows the default buffer of 250 entries.
  performance.setResourceTimingBufferSize(10_000);
  const here = () => location.pathname + location.search;
  const CLICK_KEY = '__perf_click_epoch';

  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cv = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
    return cv
      ? cv.call(el, {
          checkOpacity: true,
          checkVisibilityCSS: true,
          opacityProperty: true,
          visibilityProperty: true,
        })
      : true;
  };

  const satisfied = (conds: ReadyCondition[]): boolean =>
    conds.every((c) => {
      const els = document.querySelectorAll(c.selector);
      for (let i = 0; i < els.length; i++) {
        const el = els[i]!;
        if (visible(el) && (c.text == null || (el.textContent ?? '').includes(c.text))) return true;
      }
      return false;
    });

  /** Calls back with the time just after the next frame has been rendered. */
  const afterNextPaint = (cb: (t: number) => void) =>
    requestAnimationFrame(() => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => cb(now());
      ch.port2.postMessage(0);
    });

  const describe = (el: Element) => {
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 3) : [];
    return `${el.tagName.toLowerCase()}${cls.length ? `.${cls.join('.')}` : ''}`;
  };

  let clickEpoch: number | null = null;
  try {
    const raw = sessionStorage.getItem(CLICK_KEY);
    if (raw) clickEpoch = Number(raw);
    sessionStorage.removeItem(CLICK_KEY);
  } catch {
    // Storage can be unavailable (opaque origins); the fallback is only a hint.
  }

  let loadingUiPending = false;
  let firstPending = false;
  let stepReadyPending = false;
  let entryReadyPending = false;
  let pre = new WeakSet<Element>();

  const agent: PerfAgent = {
    step: null,
    entry: {
      key: here(),
      readyDomAt: null,
      readyAt: null,
      fcp: null,
      lcp: null,
      timeOrigin: performance.timeOrigin,
      clickEpoch,
    },

    arm(key: string): string | null {
      const conds = table[key];
      if (!conds) return `no ready conditions for ${key}`;
      if (here() === key && satisfied(conds)) {
        return `the ready conditions for ${key} already hold before the click`;
      }
      pre = new WeakSet(Array.from(document.querySelectorAll(feedback)).filter(visible));
      loadingUiPending = false;
      firstPending = false;
      stepReadyPending = false;
      agent.step = {
        key,
        from: location.href,
        t0: null,
        trigger: null,
        urlAt: null,
        loadingUiAt: null,
        loadingUiWhat: null,
        firstAt: null,
        readyDomAt: null,
        readyAt: null,
        timeOrigin: performance.timeOrigin,
      };
      requestAnimationFrame(loop);
      return null;
    },

    /** The hardware back button, as far as a page can press it. */
    back(): void {
      const s = agent.step;
      if (s && s.t0 == null) {
        s.t0 = now();
        s.trigger = 'history-back';
      }
      history.back();
    },
  };
  w.__perf = agent;

  function check() {
    const e = agent.entry;
    if (e.readyDomAt == null && !entryReadyPending) {
      const conds = table[e.key];
      if (conds && here() === e.key && satisfied(conds)) {
        e.readyDomAt = now();
        entryReadyPending = true;
        afterNextPaint((t) => {
          e.readyAt = t;
        });
      }
    }

    const s = agent.step;
    if (!s || s.t0 == null || s.readyDomAt != null) return;

    if (s.urlAt == null && location.href !== s.from) s.urlAt = now();

    if (s.loadingUiAt == null && !loadingUiPending) {
      const els = document.querySelectorAll(feedback);
      for (let i = 0; i < els.length; i++) {
        const el = els[i]!;
        if (!pre.has(el) && visible(el)) {
          loadingUiPending = true;
          s.loadingUiWhat = describe(el);
          afterNextPaint((t) => {
            s.loadingUiAt = t;
          });
          break;
        }
      }
    }

    // Before the ready check: when both hold in the same frame, both are timed.
    if (!firstPending) {
      const path = s.key.split('?')[0]!;
      const conds = first[path];
      if (conds && location.pathname === path && satisfied(conds)) {
        firstPending = true;
        afterNextPaint((t) => {
          s.firstAt = t;
        });
      }
    }

    if (!stepReadyPending && here() === s.key && satisfied(table[s.key]!)) {
      s.readyDomAt = now();
      stepReadyPending = true;
      afterNextPaint((t) => {
        s.readyAt = t;
        try {
          sessionStorage.removeItem(CLICK_KEY);
        } catch {
          // see above
        }
      });
    }
  }

  function loop() {
    check();
    const s = agent.step;
    const stepOpen = s && s.readyDomAt == null;
    const entryOpen = agent.entry.readyDomAt == null && table[agent.entry.key];
    if (stepOpen || entryOpen) requestAnimationFrame(loop);
  }

  addEventListener(
    'click',
    (ev) => {
      const s = agent.step;
      if (!s || s.t0 != null || !ev.isTrusted) return;
      // The event's own timestamp is when the input arrived, not when this
      // listener got to run, so any input delay counts too. It is on the same
      // timeline as performance.now().
      s.t0 = Math.min(ev.timeStamp, now());
      s.trigger = 'click';
      // If this click ends in a full page load after all, the next document
      // can still measure from it.
      try {
        sessionStorage.setItem(CLICK_KEY, String(performance.timeOrigin + s.t0));
      } catch {
        // see above
      }
      check();
    },
    true,
  );

  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener('currententrychange', () => {
    const s = agent.step;
    if (s && s.t0 != null && s.urlAt == null && location.href !== s.from) s.urlAt = now();
    check();
  });
  addEventListener('popstate', check);

  new MutationObserver(check).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-busy', 'role', 'data-loading'],
  });

  try {
    new PerformanceObserver((list) => {
      for (const p of list.getEntries()) {
        if (p.name === 'first-contentful-paint') agent.entry.fcp = p.startTime;
      }
    }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver((list) => {
      const all = list.getEntries();
      const last = all[all.length - 1];
      if (last) agent.entry.lcp = last.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    // Paint timing is Chromium-only; the harness only runs Chromium.
  }

  requestAnimationFrame(loop);
}
