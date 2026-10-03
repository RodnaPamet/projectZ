import AxeBuilder from '@axe-core/playwright';

import { THEME_COOKIE } from '../../../src/lib/theme-constants';
import bg from '../../../messages/bg.json';
import { expect, test } from '../fixtures';

/**
 * The club-admin shell on a 393 px phone, as the club's OWNER (T19).
 *
 * Below `md` the rail is hidden and the nav lives in inflect's vendored left
 * drawer (a vaul Sheet). What a phone user needs from it: a hamburger big
 * enough for a thumb, focus that goes in and comes back, Escape, and a drawer
 * that gets out of the way once a link is tapped. #255 (the old one-row nav
 * scrolled 541-555 px sideways here) is covered by horizontal-drift.spec.ts.
 */

const DRAWER = '[data-testid="nav-drawer"]';

test.describe('club admin shell — phone', () => {
  test('the hamburger is a 44 px target, and the rail is hidden', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
    const toggle = page.getByTestId('nav-toggle');
    await expect(toggle).toBeVisible();
    const box = (await toggle.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('aside[data-collapsed]')).toBeHidden();
    // Identity, the account menu and its theme toggle are on the phone too.
    await expect(page.getByTestId('admin-context-name')).toBeVisible();
    await expect(page.getByTestId('top-chrome-user-menu')).toBeVisible();
  });

  test('focus goes into the drawer, and Escape returns it to the hamburger', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
    const toggle = page.getByTestId('nav-toggle');
    await toggle.focus();
    await page.keyboard.press('Enter');

    const drawer = page.getByRole('dialog', { name: bg.nav.openNavigationMenu });
    await expect(drawer).toBeVisible();
    await expect
      .poll(() => drawer.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test('tapping a link navigates and closes the drawer', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
    await page.getByTestId('nav-toggle').tap();
    const link = page.locator(DRAWER).getByRole('link', { name: bg.common.nav.pricing });
    await expect(link).toBeVisible();
    await link.tap();

    await expect(page).toHaveURL(new RegExp(`/t/${isolatedTenant.tenantSlug}/admin/pricing$`));
    await expect(page.locator('main h1')).toHaveText(bg.admin.pricing.title);
    await expect(page.locator(DRAWER)).toHaveCount(0);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`axe, ${theme}: the drawer open (#317)`, async ({
      authedPage: page,
      isolatedTenant,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.getByTestId('nav-toggle').tap();
      const drawer = page.getByRole('dialog', { name: bg.nav.openNavigationMenu });
      await expect(drawer).toBeVisible();
      await expect(
        page.locator(DRAWER).getByRole('link', { name: bg.common.nav.pricing }),
      ).toBeVisible();

      // The rules the desktop shell is held to (admin-shell.spec.ts), with
      // the page behind the drawer included: what is inert must stay so.
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        .analyze();
      const report = results.violations
        .map((v) => `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes[0]?.target.join(' ')}`)
        .join('\n');
      expect(results.violations, `axe found:\n${report}`).toEqual([]);
    });
  }
});
