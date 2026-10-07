import { expect, test } from '@playwright/test';

import { THEME_COOKIE } from '../../../src/lib/theme-constants';
import {
  expectAxeClean,
  expectLanding,
  findACourt,
  sendTheContactForm,
  switchLanguageSignedOut,
} from '../utils/landing-journey';

/**
 * The landing page at 393 px (Pixel 5, #369): the same journeys as the 1280 px
 * spec, with the bottom tab bar under the footer, and nothing drifting sideways.
 */
test.describe('landing page — 393 px', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`renders every section, ${theme}, axe-clean, no drift`, async ({ page, baseURL }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await expectLanding(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expectAxeClean(page);
    });
  }

  test('"Намери корт" is a full touch target and reaches /venues', async ({ page }) => {
    await page.goto('/');
    const box = (await page
      .getByTestId('landing-find-court')
      .filter({ visible: true })
      .boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    await findACourt(page);
  });

  test('signed out, the footer switches the site to English and back', async ({ page }) => {
    await switchLanguageSignedOut(page);
  });

  test('the "For clubs" form submits and the enquiry is stored', async ({ page }) => {
    await sendTheContactForm(page, `mobile-${Date.now()}`);
  });
});
