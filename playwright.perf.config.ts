import { defineConfig } from '@playwright/test';

import { PERF_BASE_URL } from './tests/perf/config';

/**
 * The navigation-latency harness (docs/perf/README.md). Run with
 * `npm run perf:nav`.
 *
 * ═══ WHY A SEPARATE CONFIG AND NOT A PROJECT IN playwright.config.ts ═══
 *
 * Playwright's `webServer` and `globalSetup` belong to the CONFIG, not to a
 * project. A `perf` project added there would still run the e2e webServer
 * (port 3000, the e2e database, the e2e seed) and could not have its own. It
 * would also join every unpinned run: `npm run test:e2e` names no project and
 * so runs all of them. `test-infra-integrity` exists because an unpinned job
 * silently picked up a project nobody meant it to.
 *
 * So the harness has its own server (a production build on 3301, against
 * playerz_perf), its own seed, and its own two projects. Neither
 * `npm run test:e2e` nor CI's e2e job (`--project=chromium --project=mobile`,
 * default config) can reach them.
 *
 * ═══ ONE WORKER, NO RETRIES ═══
 *
 * Timings from two browsers competing for the CPU measure the competition.
 * And a retried sample is a sample picked for being fast.
 */
export default defineConfig({
  testDir: 'tests/perf',
  testMatch: /nav-latency\.spec\.ts$/,
  outputDir: 'test-results/perf',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  // One test is one fresh context going round its loop twice, which on the
  // phone profile is a minute or two.
  timeout: 10 * 60_000,
  reporter: [['list'], ['./tests/perf/reporter.ts']],

  use: {
    baseURL: PERF_BASE_URL,
    // A click that cannot happen should fail the run in seconds, not after
    // the ten-minute test timeout.
    actionTimeout: 30_000,
    // Tracing, video and screenshots all cost CPU on the machine being timed.
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    // Full Chromium in new headless mode, not the stripped headless shell.
    // The shell renders differently, and rendering is part of what is timed.
    //
    // PERF_HEADLESS_SHELL=1 swaps in the shell, only for a machine where full
    // Chromium cannot start: on 1 October 2026 it hung at launch on the perf
    // Mac, inside CryptoTokenKit's XPC call to `ctkd`, before Playwright's
    // pipe connected. Compare shell runs only with shell runs.
    browserName: 'chromium',
    channel: process.env.PERF_HEADLESS_SHELL === '1' ? undefined : 'chromium',
  },

  // The device, the throttling and the input method come from
  // tests/perf/config.ts PROFILES, applied per context in harness.ts.
  projects: [
    { name: 'perf-phone', metadata: { profile: 'phone' } },
    { name: 'perf-desktop', metadata: { profile: 'desktop' } },
  ],

  globalSetup: './tests/perf/global-setup.ts',

  webServer: {
    // Reset and seed playerz_perf, `next build`, then `next start -p 3301`.
    // See tests/perf/serve.ts.
    command: 'npx tsx tests/perf/serve.ts',
    url: `${PERF_BASE_URL}/api/health`,
    // Never a server left over from an earlier build, for the reason
    // playwright.config.ts gives.
    reuseExistingServer: false,
    timeout: 15 * 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
