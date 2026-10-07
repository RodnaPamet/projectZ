import { expect, test, type Page } from '@playwright/test';

import { test as authedTest } from '../fixtures';

/**
 * NO PAGE SCROLLS SIDEWAYS ON A PHONE.
 *
 * Horizontal drift is the #1 mobile bug class: the user swipes down a list, the
 * whole page slides left, the layout tears — and it looks perfectly fine to
 * whoever built it on a 27-inch monitor. On iOS it is worse than cosmetic,
 * because the sideways rubber-band chains into the back-navigation gesture and
 * the user simply loses the page they were on.
 *
 * ─── This spec is HALF of the promise ────────────────────────────────
 *
 * It measures the ground truth — `scrollWidth > clientWidth` on a real page in a
 * real browser at a real phone width — but it can only test the pages that
 * EXIST. Every page not yet written is one PR away from reintroducing the bug,
 * and this file would not know.
 *
 * The other half is tests/guardrails/no-horizontal-drift-patterns.test.ts, which
 * bans the root-cause patterns in source whether or not any page renders them.
 * Neither is sufficient alone: the guard cannot prove a page is fine, and this
 * cannot prove a component is.
 *
 * ─── Adding a page ───────────────────────────────────────────────────
 *
 * One line in PAGES and it is guarded forever.
 */

const PAGES: ReadonlyArray<{ label: string; path: string }> = [
  { label: 'home', path: '/' },
  { label: 'venues (the public list)', path: '/venues' },
  { label: 'offline fallback', path: '/offline' },

  /**
   * THE IMPORTANT ONE.
   *
   * /design-system renders the entire component library on a single page —
   * every table, popover, combobox, filter, card and form primitive we ship.
   *
   * So one drift assertion here exercises the whole library at once. It is
   * strictly stronger coverage than the three product routes above, and it is
   * what makes "structural, not a sample" true for a codebase whose route tree
   * is still small: a component that drifts is caught the day it is written,
   * long before any page uses it.
   */
  { label: 'design system (the whole component library)', path: '/design-system' },
];

/**
 * Does the document scroll sideways?
 *
 * `documentElement` — not `body`. The overflow can land on either, and checking
 * only body misses the common case entirely.
 *
 * A 1px tolerance: sub-pixel layout rounding (a 0.5px border on a fractional
 * device pixel ratio) can produce a scrollWidth one greater than clientWidth on
 * a page that is visually perfect. Tolerating one pixel keeps the ratchet
 * honest; tolerating ten would let a real bug through.
 */
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;

    return Math.max(doc.scrollWidth - doc.clientWidth, body.scrollWidth - body.clientWidth);
  });
}

/** The widest element that is actually sticking out, so a failure is actionable. */
async function widestOffender(page: Page): Promise<string> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;

    const offenders = [...document.querySelectorAll<HTMLElement>('*')]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, overflow: Math.round(rect.right - limit) };
      })
      .filter((x) => x.overflow > 1)
      .sort((a, b) => b.overflow - a.overflow)
      .slice(0, 3);

    if (offenders.length === 0) return '(nothing measurable — the overflow may be a margin)';

    return offenders
      .map(({ el, overflow }) => {
        const cls = typeof el.className === 'string' ? el.className.slice(0, 90) : '';
        return `    +${overflow}px  <${el.tagName.toLowerCase()} class="${cls}">`;
      })
      .join('\n');
  });
}

/** Wait for a settled layout, then fail with the widest offenders if the page scrolls sideways. */
async function expectNoDrift(page: Page, path: string): Promise<void> {
  // NOT `networkidle`.
  //
  // This app holds a PERSISTENT realtime connection (Centrifugo, P15), so
  // the network never goes quiet and `waitForLoadState('networkidle')` waits
  // for a silence that will never arrive. It does not fail as a drift
  // assertion — it fails as a 30-second timeout, which looks like a bug in
  // the page and is a bug in the test.
  //
  // Wait for something DETERMINISTIC instead: the DOM is parsed, the fonts
  // have resolved (a font swap can change layout width), and the frame has
  // painted.
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));

  const overflow = await horizontalOverflow(page);

  if (overflow > 1) {
    const offenders = await widestOffender(page);

    throw new Error(
      `${path} scrolls sideways by ${overflow}px at ${page.viewportSize()?.width}px.\n\n` +
        `  Widest offenders:\n${offenders}\n\n` +
        `The user swipes down the list and the whole page slides left. On iOS the\n` +
        `sideways rubber-band chains into the back gesture, so they lose the page.\n\n` +
        `Usual causes: an uncompensated negative margin, a table with no\n` +
        `overflow-x-auto, a fixed-width element, or a long unbroken string.\n` +
        `See tests/guardrails/no-horizontal-drift-patterns.test.ts.`,
    );
  }

  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('@mobile horizontal drift', () => {
  for (const { label, path } of PAGES) {
    test(`${label} does not scroll sideways`, async ({ page }) => {
      await page.goto(path);
      await expectNoDrift(page, path);
    });
  }

  /**
   * The measurement itself must be able to FAIL.
   *
   * A spec that cannot go red is a spec that proves nothing, and a viewport
   * misconfiguration (running the "mobile" project at desktop width) would make
   * every assertion above vacuously green while looking perfectly healthy.
   */
  test('the drift measurement actually detects overflow', async ({ page }) => {
    await page.goto('/');

    const width = page.viewportSize()?.width ?? 0;
    expect(width).toBeLessThanOrEqual(430); // we really are on a phone

    // Inject something that unambiguously overflows.
    await page.evaluate(() => {
      const el = document.createElement('div');
      el.style.width = '3000px';
      el.style.height = '1px';
      el.id = 'drift-canary';
      document.body.appendChild(el);
    });

    expect(await horizontalOverflow(page)).toBeGreaterThan(1);

    await page.evaluate(() => document.getElementById('drift-canary')?.remove());

    // …and the page is clean again once it is gone.
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });
});

/**
 * THE CLUB ADMIN, SIGNED IN AS ITS OWNER (#255).
 *
 * The club nav was nine links in one row that could not wrap: 541-555 px of
 * sideways scroll on this phone, on every club page. T19 moved them into the
 * admin shell's drawer. Each page is measured with the drawer closed, which
 * is how a page is read.
 */
const CLUB_PAGES = ['calendar', 'courts', 'pricing', 'players', 'staff', 'reports'] as const;

authedTest.describe('@mobile horizontal drift — club admin', () => {
  for (const p of CLUB_PAGES) {
    authedTest(`club ${p} does not scroll sideways`, async ({ authedPage, isolatedTenant }) => {
      const path = `/t/${isolatedTenant.tenantSlug}/admin/${p}`;
      await authedPage.goto(path);
      await expect(authedPage.locator('main h1')).toBeVisible();
      await expectNoDrift(authedPage, path);
    });
  }
});

/**
 * A PLAYER's own page, with the player chrome around it (T20): the header,
 * and the bottom tab bar with all three of its tabs.
 */
authedTest.describe('@mobile horizontal drift — player', () => {
  authedTest('my bookings does not scroll sideways', async ({ playerPage }) => {
    await playerPage.goto('/me/bookings');
    // By role, not `main h1`: under the 300 ms reveal throttle a streamed page
    // sits in a hidden copy beside the shown one, and `main h1` finds both.
    await expect(playerPage.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoDrift(playerPage, '/me/bookings');
  });
});
