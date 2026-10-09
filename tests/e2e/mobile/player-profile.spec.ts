import type { Page } from '@playwright/test';

import { expect, test } from '../fixtures';
import { expectAxeClean } from '../utils/booking-detail-journey';
import { setNameAndLevels } from '../utils/profile-journey';
import { settleAnimations } from '../utils/settle-animations';

/**
 * /me/profile's #359 sections on a 393 px phone: the desktop journey in a
 * bottom sheet, with no sideways drift, and axe on the open sports sheet.
 */

async function expectNoDrift(page: Page) {
  const overflow = await page.evaluate(() =>
    Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth,
    ),
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('player profile — phone', () => {
  test('set a name and levels, then see them, with no drift', async ({ playerPage: page }) => {
    await setNameAndLevels(page);
    await expectNoDrift(page);
  });

  test('axe: the sports sheet with a level open', async ({ playerPage: page }) => {
    await page.goto('/me/profile');
    // Scoped to the visible <main>: while the page streams, Next keeps a
    // hidden copy of it in the document, and a bare test id matches both.
    await page.getByRole('main').getByTestId('profile-sports-edit').click();
    await page.getByTestId('profile-sport-pick-PADEL').getByRole('checkbox').click();
    await expect(page.getByTestId('profile-sport-pick-PADEL-meaning')).toBeVisible();
    await settleAnimations(page.getByRole('dialog'));
    await expectAxeClean(page);
    await expectNoDrift(page);
  });
});
