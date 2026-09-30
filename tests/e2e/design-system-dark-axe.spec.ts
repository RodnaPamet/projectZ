import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { THEME_COOKIE } from '../../src/lib/theme-constants';

/**
 * The design system is accessible in the DARK theme too.
 *
 * design-system-smoke.spec.ts runs axe under Playwright's default
 * `prefers-color-scheme: light`, so it has only ever measured the light
 * palette. Dark is the default theme — the one every first visit without a
 * light OS preference gets — and it had no contrast check in a browser at all.
 *
 * The theme comes from the COOKIE, the same channel a returning visitor's
 * choice travels on, so this also exercises the server-rendered `data-theme`:
 * the first byte is already dark, nothing flips after load, and there is no
 * mid-transition colour for axe to sample (the #115 failure mode).
 *
 * The `-dark` suffix keeps it out of the firefox project (playwright.config.ts)
 * along with the other dark-theme spec.
 */
test.describe('design system — dark theme accessibility', () => {
  test('has zero critical or serious axe violations in dark', async ({ page, baseURL }) => {
    await page.context().addCookies([{ name: THEME_COOKIE, value: 'dark', url: baseURL! }]);
    await page.goto('/design-system');

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    const report = blocking
      .map((v) => `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes[0]?.target.join(' ')}`)
      .join('\n');

    expect(blocking, `axe found ${blocking.length} blocking violation(s):\n${report}`).toEqual([]);
  });
});
