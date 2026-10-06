import bg from '../../messages/bg.json';

import { expect, test } from './fixtures';
import { grantModerator } from './utils/create-player';

/**
 * The player chrome at 1280 px (T20, #362): the header's top links, the bell,
 * a club account's "← Към админ", and the account menu, with no tab bar. The
 * phone half is tests/e2e/mobile/player-shell.spec.ts.
 */
test.use({ viewport: { width: 1280, height: 800 } });

const TOP_NAV = `header nav[aria-label="${bg.common.ui.mainNav}"]`;
const TAB_BAR = `nav[aria-label="${bg.common.nav.tabBar}"]`;
const MENU_ROWS = '[role="menu"] a, [role="menu"] [data-testid="user-menu-sign-out"]';
const n = bg.common.nav;

async function openMenu(page: import('@playwright/test').Page) {
  await page.locator('header').getByTestId('top-chrome-user-menu').click();
  const menu = page.getByRole('menu', { name: bg.nav.accountMenu });
  await expect(menu).toBeVisible();
  return menu;
}

test.describe('player shell — desktop', () => {
  test('signed out: Играй and Вход in the header, no tab bar', async ({ page }) => {
    await page.goto('/venues');
    await expect(page.locator(TOP_NAV).getByRole('link', { name: n.play })).toBeVisible();
    await expect(page.locator('header a[href="/login"]')).toBeVisible();
    await expect(page.locator(TAB_BAR)).toBeHidden();
  });

  test('player: Играй and Резервации, the bell, and the account menu', async ({
    playerPage: page,
    player,
  }) => {
    await page.goto('/venues');
    const nav = page.locator(TOP_NAV);
    await expect(nav.getByRole('link')).toHaveText([n.play, n.bookings]);
    await nav.getByRole('link', { name: n.bookings }).click();
    await expect(page).toHaveURL(/\/me\/bookings$/);
    await expect(page.getByRole('heading', { level: 1, name: bg.myBookings.title })).toBeVisible();
    await expect(page.locator(TAB_BAR)).toBeHidden();
    await expect(page.getByTestId('site-header-admin')).toHaveCount(0);
    await expect(page.getByTestId('header-notifications')).toBeVisible();
    await expect(page.getByTestId('header-messages')).toHaveCount(0);

    const menu = await openMenu(page);
    await expect(menu.getByTestId('user-menu-display-name')).toHaveText(player.name);
    await expect(page.locator(MENU_ROWS)).toHaveText([n.profile, bg.common.signOut]);
    await expect(menu.getByTestId('user-menu-theme-row')).toBeVisible();
  });

  test('player: the menu’s Профил opens the page; theme and Изход are the menu’s here', async ({
    playerPage: page,
  }) => {
    await page.goto('/venues');
    const menu = await openMenu(page);
    await menu.getByTestId('user-menu-profile').click();
    await expect(page).toHaveURL(/\/me\/profile$/);
    await expect(page.getByTestId('profile-language-row')).toBeVisible();
    // One control, one place: from md the menu holds these.
    await expect(page.getByTestId('profile-theme-row')).toBeHidden();
    await expect(page.getByTestId('profile-sign-out')).toBeHidden();
  });

  test('moderator: Платформа in the account menu, to the first platform page', async ({
    playerPage: page,
    player,
    isolatedTenant,
  }) => {
    await grantModerator(player.userId, isolatedTenant.userId);
    await page.goto('/venues');
    await openMenu(page);
    await expect(page.locator(MENU_ROWS)).toHaveText([n.profile, n.platform, bg.common.signOut]);
    await page.getByTestId('user-menu-platform').click();
    await expect(page).toHaveURL(/\/platform\/moderation$/);

    // And back out to the public site (#347).
    await page.getByTestId('admin-public-link').click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('club account: "← Към админ", "Админ на клуба", and no Резервации', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    await page.goto('/venues');
    const admin = page.getByTestId('site-header-admin');
    await expect(admin).toHaveText(n.backToAdmin);
    await expect(admin).toHaveAttribute('href', `/t/${isolatedTenant.tenantSlug}/admin/calendar`);
    await expect(page.locator(TOP_NAV).getByRole('link', { name: n.bookings })).toHaveCount(0);

    await openMenu(page);
    await expect(page.locator(MENU_ROWS)).toHaveText([n.clubAdmin, n.profile, bg.common.signOut]);

    // A club account cannot book, so Резервации is not its page (audit C12):
    // it goes where it lands after sign-in, its club's diary.
    await page.goto('/me/bookings');
    await expect(page).toHaveURL(new RegExp(`/t/${isolatedTenant.tenantSlug}/admin/calendar$`));
  });

  test('club account: public → admin → public, both directions', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    await page.goto('/venues');
    await page.getByTestId('site-header-admin').click();
    await expect(page).toHaveURL(new RegExp(`/t/${isolatedTenant.tenantSlug}/admin/calendar$`));
    await expect(page.locator('main h1')).toHaveText(bg.admin.calendar.title);

    const pub = page.getByTestId('admin-public-link');
    await expect(pub).toBeVisible();
    await pub.click();
    await expect(page).toHaveURL(/\/venues$/);
    await expect(page.getByTestId('site-header-admin')).toBeVisible();
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
