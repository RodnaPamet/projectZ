import { expect, test } from '@playwright/test';

/**
 * P02 — dark-theme baseline. The committed PNGs are the reference for
 * the nightly visual-regression compare (`nightly.yml`, `--grep @visual`),
 * so a token change that silently breaks the dark theme gets caught.
 */

test.describe('design system — dark @visual', () => {
  test.use({ colorScheme: 'dark' });

  test('buttons match the dark baseline', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/design-system');

    // The theme is applied on mount; wait for the attribute rather than a
    // fixed timeout so this is not flaky on a slow runner.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Animations would make the screenshots non-deterministic.
    await page.addStyleTag({
      content: `*, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }`,
    });

    const buttons = page.getByTestId('ds-section-Button');
    await expect(buttons).toBeVisible();
    await expect(buttons).toHaveScreenshot('dark-buttons.png', { maxDiffPixelRatio: 0.01 });
  });
});
