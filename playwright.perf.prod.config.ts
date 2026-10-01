import { defineConfig } from '@playwright/test';

import base from './playwright.perf.config';
import { PERF_BASE_URL, PERF_REMOTE } from './tests/perf/config';

/**
 * The navigation-latency harness against a server it did not start: by
 * default production. Run with `npm run perf:nav:prod`; see
 * docs/perf/README.md, "Production".
 *
 * No webServer and no globalSetup: nothing is built, served, seeded or signed
 * in. With PERF_BASE_URL set, the spec registers only the anonymous journeys
 * (tests/perf/nav-latency.spec.ts), so a run against a live server is
 * read-only by construction. The phone keeps CPU ×4 and drops its emulated
 * network, because the round trip is now real (tests/perf/config.ts).
 */
if (!PERF_REMOTE) {
  throw new Error(
    'playwright.perf.prod.config.ts needs PERF_BASE_URL (npm run perf:nav:prod sets it).',
  );
}

/**
 * PERF_HEADLESS_SHELL=1 swaps full Chromium for the headless shell. Only for
 * a machine where full Chromium cannot start: on 1 October 2026 it hung at
 * launch on this Mac, inside CryptoTokenKit's XPC call to `ctkd`, before
 * Playwright's pipe connected. The shell renders differently, so a run that
 * uses it records `chromium` as the shell's version and says so in its notes.
 */
const shell = process.env.PERF_HEADLESS_SHELL === '1';

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: PERF_BASE_URL, ...(shell ? { channel: undefined } : {}) },
  globalSetup: undefined,
  webServer: undefined,
});
