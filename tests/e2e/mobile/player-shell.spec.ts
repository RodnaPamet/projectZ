import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { THEME_COOKIE } from '../../../src/lib/theme-constants';
import { expect, test } from '../fixtures';

/**
 * The player chrome on a 393 px phone (T20): a bottom tab bar under the
 * thumb, by account kind (#263), and a header that is only the wordmark (plus
 * a CLUB account's way back to its club).
 *
 *   signed out   Discover · Sign in
 *   player       Discover · My bookings · Account
 *   club         Discover · Account
 *
 * Sideways scroll on these pages is horizontal-drift.spec.ts's job; this
 * checks the bar does not add any, at the width it exists for.
 */

const TAB_BAR = `nav[aria-label="${bg.common.nav.tabBar}"]`;
/**
 * The tabs themselves: each `li`'s own link or button. Not any button in the
 * bar, because the Account tab keeps the vendored menu's avatar trigger,
 * inert and invisible, as its anchor.
 */
const TABS = `${TAB_BAR} li > a, ${TAB_BAR} li > button`;
const n = bg.common.nav;

async function expectTargets(page: Page) {
  const targets = page.locator(TABS);
  const count = await targets.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const box = (await targets.nth(i).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
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

async function tabNames(page: Page): Promise<string[]> {
  return page.locator(TABS).allInnerTexts();
}

test.describe('player shell — phone', () => {
  test('signed out: Discover and Sign in, under the thumb', async ({ page }) => {
    await page.goto('/venues');
    const bar = page.locator(TAB_BAR);
    await expect(bar).toBeVisible();
    expect((await tabNames(page)).map((s) => s.trim())).toEqual([n.play, n.signIn]);
    await expect(bar.getByRole('link', { name: n.play })).toHaveAttribute('aria-current', 'page');

    // The header's own links are the desktop's: one copy on a phone.
    await expect(page.getByRole('navigation', { name: bg.common.ui.mainNav })).toBeHidden();

    // Fixed to the bottom of the viewport, and it lifts the toaster with it.
    const box = (await bar.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(page.viewportSize()!.height);
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--app-bottom-inset'),
      ),
    ).toContain('3.5rem');

    await expectTargets(page);
    await expectNoDrift(page);
  });

  test('a tab tap navigates, and the bar stays', async ({ page }) => {
    await page.goto('/');
    await page.locator(TAB_BAR).getByRole('link', { name: n.play }).tap();
    await expect(page).toHaveURL(/\/venues$/);
    await expect(page.getByRole('heading', { level: 1, name: bg.venues.title })).toBeVisible();
    await expect(page.locator(TAB_BAR)).toBeVisible();
  });

  test('is not on /login, where the page has one job', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: bg.login.title })).toBeVisible();
    await expect(page.locator(TAB_BAR)).toHaveCount(0);
  });

  test('player: Discover, My bookings and Account — and no club anywhere', async ({
    playerPage: page,
  }) => {
    await page.goto('/me/bookings');
    // By role, not `main h1`: under the 300 ms reveal throttle a streamed page
    // sits in a hidden copy beside the shown one, and `main h1` finds both.
    await expect(page.getByRole('heading', { level: 1, name: bg.myBookings.title })).toBeVisible();
    expect((await tabNames(page)).map((s) => s.trim())).toEqual([n.play, n.myBookings, n.account]);
    await expect(page.locator(TAB_BAR).getByRole('link', { name: n.myBookings })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByTestId('site-header-club')).toHaveCount(0);
    await expect(page.locator('a[href^="/t/"]')).toHaveCount(0);

    await expectTargets(page);
    await expectNoDrift(page);
  });

  test('player: Account opens the account sheet, and Escape gives focus back', async ({
    playerPage: page,
    player,
  }) => {
    await page.goto('/venues');
    // By test id: once the sheet is open it hides the rest of the page from
    // the accessibility tree, so a role query can no longer find the tab.
    const account = page.getByTestId('bottom-tab-account');
    await expect(account).toHaveAccessibleName(n.account);
    await account.tap();
    await expect(account).toHaveAttribute('aria-expanded', 'true');

    const menu = page.getByRole('menu', { name: bg.nav.accountMenu });
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('user-menu-display-name')).toHaveText(player.name);
    await expect(menu.getByTestId('user-menu-sign-out')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(account).toBeFocused();
  });

  test('club account: Discover and Account, and its club in the header', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    await page.goto('/venues');
    expect((await tabNames(page)).map((s) => s.trim())).toEqual([n.play, n.account]);
    const club = page.getByTestId('site-header-club');
    await expect(club).toBeVisible();
    await expect(club).toHaveText(`E2E ${isolatedTenant.tenantSlug}`);
    await expect(page.locator(TAB_BAR).locator('a[href^="/t/"]')).toHaveCount(0);
    await expectNoDrift(page);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`axe: signed out /venues, ${theme}`, async ({ page, baseURL }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto('/venues');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator(TAB_BAR)).toBeVisible();
      await expectAxeClean(page);
    });

    test(`axe: player /me/bookings, ${theme}`, async ({ playerPage: page, baseURL }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto('/me/bookings');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator(TAB_BAR)).toBeVisible();
      await expectAxeClean(page);
    });
  }
});
