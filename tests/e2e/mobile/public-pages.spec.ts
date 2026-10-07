import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { THEME_COOKIE } from '../../../src/lib/theme-constants';

/**
 * The public pages on a 393 px phone, light and dark (T27): `/`, `/venues`
 * and `/login`, signed out. The desktop half is tests/e2e/public-pages.spec.ts.
 *
 * On a phone the buttons are what a thumb has to hit, so the CTA's 44 px
 * touch target is checked here, where the coarse pointer gives it one.
 */

const PAGES = [
  { path: '/', heading: bg.landing.hero.title },
  { path: '/venues', heading: bg.venues.title },
  { path: '/login', heading: bg.login.title },
] as const;

async function expectAxeClean(page: Page) {
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
}

async function expectNoDrift(page: Page) {
  const overflow = await page.evaluate(() =>
    Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth,
    ),
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('public pages — phone', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const { path, heading } of PAGES) {
      test(`${path}, ${theme}: axe-clean, no drift`, async ({ page, baseURL }) => {
        await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
        await page.goto(path);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();

        await expectAxeClean(page);
        await expectNoDrift(page);
      });
    }
  }

  test('/: the call to action is a full touch target', async ({ page }) => {
    await page.goto('/');
    const cta = page.getByTestId('landing-find-court').filter({ visible: true });
    await expect(cta).toHaveAttribute('href', '/venues');
    await expect(cta).toHaveText(bg.landing.hero.cta);
    const box = (await cta.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('/venues: the cards keep the side gutter', async ({ page }) => {
    await page.goto('/venues');
    const card = page.getByRole('main').getByRole('listitem').first();
    await expect(card).toBeVisible();
    // safe-area-x and px-6 on different elements (see venues/page.tsx): the
    // cards ran edge to edge at 393 px when they shared one.
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(16);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width - 16);
  });
});
