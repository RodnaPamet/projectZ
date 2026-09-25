import { defineConfig, devices } from '@playwright/test';

const PORT = 3000;
const baseURL = `http://localhost:${PORT}`;

/**
 * P02 wires a real webServer so the design-system specs have an app to
 * drive. P03 replaces this with the full spine (globalSetup, isolated
 * tenant + authedPage fixtures, firefox project, junit reporter).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL,
    trace: 'retain-on-first-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // Desktop must not run the mobile specs — a drift assertion at 1280px is
      // vacuously green.
      testIgnore: /mobile\/.*\.spec\.ts$/,
    },

    /**
     * Firefox. Runs ONLY in the nightly (`nightly.yml` matrix), never per-PR —
     * a slow second browser must not gate a merge.
     *
     * Until now `nightly.yml` passed `--project=firefox` at a config that
     * defined only `chromium` and `mobile`, so the firefox leg died on
     * `Project(s) "firefox" not found` — it had never run a spec.
     *
     * ═══ WHY IT SKIPS THE VISUAL SPEC ═══
     *
     * Playwright names a snapshot after the project that took it, and the only
     * committed baselines are `dark-*-chromium-linux.png`. Running the @visual
     * spec here would look for `dark-buttons-firefox-linux.png`, find nothing,
     * and fail as a MISSING snapshot — which reads exactly like a real visual
     * regression while proving nothing about the dark theme.
     *
     * Cross-browser coverage is about behaviour; pixel comparison stays on one
     * browser deliberately. Adding firefox baselines would double the images to
     * re-bless on every token change for no extra signal.
     */
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testIgnore: [/mobile\/.*\.spec\.ts$/, /-dark\.spec\.ts$/],
    },

    /**
     * The mobile project. Everything under tests/e2e/mobile/ runs HERE and only
     * here.
     *
     * Pixel 5 is 393x851 — a real, common phone, and narrow enough that anything
     * which drifts sideways will do so. Testing "mobile" at 768px proves nothing:
     * that is a tablet, and it is wide enough to hide the bug.
     */
    {
      name: 'mobile',
      testMatch: /mobile\/.*\.spec\.ts$/,
      use: { ...devices['Pixel 5'] },
    },
  ],

  // The public pages read real venues. Without a seed, `/venues` renders the
  // empty state and the specs would pass by asserting nothing — the classic
  // vacuous E2E.
  globalSetup: './tests/e2e/global-setup.ts',

  webServer: {
    // `next start` against a production build — dev-mode HMR overlays and
    // on-demand recompiles make axe runs and screenshots flaky.
    command: 'npm run build && npm run start',
    url: baseURL,
    // Deliberately NEVER reuse. With `reuseExistingServer: !CI` a server
    // left running from an earlier invocation keeps serving its OLD build,
    // so token/CSS changes are silently invisible to the specs — an axe
    // run and a screenshot baseline were both produced against stale CSS
    // before this was caught. Always rebuild; correctness beats the ~30s.
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
