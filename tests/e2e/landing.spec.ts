import { expect, test } from '@playwright/test';

import { THEME_COOKIE } from '../../src/lib/theme-constants';
import {
  expectAxeClean,
  expectLanding,
  findACourt,
  sendTheContactForm,
  switchLanguageSignedOut,
} from './utils/landing-journey';

/**
 * The landing page at 1280 px (#369), and the signed-out language switch (#368).
 * tests/e2e/mobile/landing.spec.ts walks the same journeys at 393 px.
 */
test.describe('landing page — desktop', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`renders every section, ${theme}, axe-clean, no drift`, async ({ page, baseURL }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await expectLanding(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expectAxeClean(page);
    });
  }

  test('"Намери корт" reaches /venues', async ({ page }) => {
    await findACourt(page);
  });

  test('signed out, the footer switches the site to English and back', async ({ page }) => {
    await switchLanguageSignedOut(page);
  });

  test('the "For clubs" form submits and the enquiry is stored', async ({ page }) => {
    await sendTheContactForm(page, `desktop-${Date.now()}`);
  });
});
