import bg from '../../messages/bg.json';

import { expect, test } from './fixtures';

/**
 * The player chrome at 1280 px (T20): the header's top links and the account
 * menu, and no tab bar. The phone half is tests/e2e/mobile/player-shell.spec.ts.
 */
test.use({ viewport: { width: 1280, height: 800 } });

const TOP_NAV = `header nav[aria-label="${bg.common.ui.mainNav}"]`;
const TAB_BAR = `nav[aria-label="${bg.common.nav.tabBar}"]`;
const n = bg.common.nav;

test.describe('player shell — desktop', () => {
  test('signed out: Discover and Sign in in the header, no tab bar', async ({ page }) => {
    await page.goto('/venues');
    await expect(page.locator(TOP_NAV).getByRole('link', { name: n.play })).toBeVisible();
    await expect(page.locator('header a[href="/login"]')).toBeVisible();
    await expect(page.locator(TAB_BAR)).toBeHidden();
  });

  test('player: Discover and My bookings, and the account menu', async ({
    playerPage: page,
    player,
  }) => {
    await page.goto('/venues');
    const nav = page.locator(TOP_NAV);
    await expect(nav.getByRole('link', { name: n.play })).toBeVisible();
    await nav.getByRole('link', { name: n.myBookings }).click();
    await expect(page).toHaveURL(/\/me\/bookings$/);
    await expect(page.getByRole('heading', { level: 1, name: bg.myBookings.title })).toBeVisible();
    await expect(page.locator(TAB_BAR)).toBeHidden();
    await expect(page.getByTestId('site-header-club')).toHaveCount(0);

    // The header's trigger; the tab bar's inert copy is hidden at this width.
    await page.locator('header').getByTestId('top-chrome-user-menu').click();
    const menu = page.getByRole('menu', { name: bg.nav.accountMenu });
    await expect(menu.getByTestId('user-menu-display-name')).toHaveText(player.name);
    await expect(menu.getByTestId('user-menu-sign-out')).toBeVisible();
  });

  test('club account: its club, no My bookings', async ({ authedPage: page, isolatedTenant }) => {
    await page.goto('/venues');
    await expect(page.getByTestId('site-header-club')).toHaveText(
      `E2E ${isolatedTenant.tenantSlug}`,
    );
    await expect(page.locator(TOP_NAV).getByRole('link', { name: n.myBookings })).toHaveCount(0);

    // A club account cannot book, so "My bookings" is not its page (audit C12):
    // it goes where it lands after sign-in, its club's diary.
    await page.goto('/me/bookings');
    await expect(page).toHaveURL(new RegExp(`/t/${isolatedTenant.tenantSlug}/admin/calendar$`));
  });

  test('/login does not link to itself (#319, audit A05)', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator(TOP_NAV).getByRole('link', { name: n.play })).toBeVisible();
    await expect(page.locator('header a[href="/login"]')).toHaveCount(0);
  });

  test('the 404 wears the chrome, and offers more than one way on (audit A06)', async ({
    page,
  }) => {
    const res = await page.goto('/no-such-page');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: bg.notFound.title })).toBeAttached();
    await expect(page.locator(TOP_NAV).getByRole('link', { name: n.play })).toBeVisible();
    await expect(page.locator('header a[href="/login"]')).toBeVisible();
    const main = page.locator('main');
    await expect(main.getByRole('link', { name: bg.notFound.backToVenues })).toHaveAttribute(
      'href',
      '/venues',
    );
    await expect(main.getByRole('link', { name: bg.notFound.home })).toHaveAttribute('href', '/');
  });
});
