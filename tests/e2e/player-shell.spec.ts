import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import bg from '../../messages/bg.json';
import { THEME_COOKIE } from '../../src/lib/theme-constants';
import { UI_STORAGE_PREFIX } from '../../src/lib/ui-storage';

import { expect, test } from './fixtures';
import { grantModerator } from './utils/create-player';

/**
 * The site's frames at 1280 px (#362, owner 2026-10-07): a visitor gets the
 * public header, every signed-in account inflect's AppShell with the sidebar
 * on the LEFT, the same frame the club admin wears.
 *
 *   signed out   the header's Играй and Вход
 *   player,      the rail: Играй · Резервации · Профил (a grant holder's
 *   coach        "Платформа" under them), the bell and the account menu
 *   club         its club admin's rail, on public pages as in the admin
 *
 * The phone half (the drawer, the bottom bar) is tests/e2e/mobile/player-shell.spec.ts.
 */
test.use({ viewport: { width: 1280, height: 800 } });

const n = bg.common.nav;
const PUBLIC_NAV = `header nav[aria-label="${bg.common.ui.mainNav}"]`;
const RAIL = `aside nav[aria-label="${bg.common.ui.mainNav}"]`;
const TAB_BAR = `nav[aria-label="${n.tabBar}"]`;
const MENU_ROWS = '[role="menu"] a, [role="menu"] [data-testid="user-menu-sign-out"]';
const COLLAPSE_KEY = `${UI_STORAGE_PREFIX}:sidebar-collapsed`;

async function openMenu(page: Page) {
  await page.locator('header').getByTestId('top-chrome-user-menu').click();
  const menu = page.getByRole('menu', { name: bg.nav.accountMenu });
  await expect(menu).toBeVisible();
  return menu;
}

async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
  const report = results.violations
    .map((v) => `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes[0]?.target.join(' ')}`)
    .join('\n');
  expect(results.violations, `axe found:\n${report}`).toEqual([]);
}

test.describe('the frames — desktop', () => {
  test('signed out: the public header, Играй and Вход, and no sidebar', async ({ page }) => {
    await page.goto('/venues');
    await expect(page.locator(PUBLIC_NAV).getByRole('link', { name: n.play })).toBeVisible();
    await expect(page.locator('header a[href="/login"]')).toBeVisible();
    await expect(page.locator('aside')).toHaveCount(0);
    await expect(page.locator(TAB_BAR)).toBeHidden();
    await expect(page.getByTestId('site-footer')).toBeVisible();
  });

  test('player: the left rail, Играй · Резервации · Профил, and the bar hidden', async ({
    playerPage: page,
    player,
  }) => {
    await page.goto('/venues');
    const rail = page.locator(RAIL);
    await expect(rail).toBeVisible();
    await expect(rail.getByRole('link')).toHaveText([n.play, n.bookings, n.profile]);
    // On the LEFT: the rail starts at the window's edge, the page to its right.
    const railBox = (await page.locator('aside').boundingBox())!;
    const mainBox = (await page.locator('main').boundingBox())!;
    expect(railBox.x).toBe(0);
    expect(mainBox.x).toBeGreaterThanOrEqual(railBox.width);

    await rail.getByRole('link', { name: n.bookings }).click();
    await expect(page).toHaveURL(/\/me\/bookings$/);
    await expect(page.getByRole('heading', { level: 1, name: bg.myBookings.title })).toBeVisible();
    await expect(rail).toBeVisible();

    // The top bar: the wordmark home to Играй, the bell, the account menu.
    await expect(page.getByTestId('shell-wordmark')).toHaveAttribute('href', '/venues');
    await expect(page.getByTestId('header-notifications')).toBeVisible();
    await expect(page.locator(TAB_BAR)).toBeHidden();
    await expect(page.getByTestId('site-footer')).toHaveCount(0);
    await expect(page.locator('header a[href="/login"]')).toHaveCount(0);
    await expect(page.locator('a[href^="/t/"]')).toHaveCount(0);

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
    await expect(page.getByTestId('profile-theme-row')).toBeHidden();
    await expect(page.getByTestId('profile-sign-out')).toBeHidden();
  });

  test('player: signed in, `/` is Играй', async ({ playerPage: page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/venues$/);
    await expect(page.getByRole('heading', { level: 1, name: bg.venues.title })).toBeVisible();
    await expect(page.locator(RAIL)).toBeVisible();
  });

  test('the rail collapses, and stays collapsed from Играй to Резервации', async ({
    playerPage: page,
  }) => {
    await page.goto('/venues');
    const aside = page.locator('aside[data-collapsed]');
    await expect(aside).toHaveAttribute('data-collapsed', 'false');
    await page.getByTestId('sidebar-collapse-toggle').click();
    await expect(aside).toHaveAttribute('data-collapsed', 'true');
    expect(await page.evaluate((k) => localStorage.getItem(k), COLLAPSE_KEY)).toBe('true');

    // One layout for both pages: the frame is not remounted, so it never
    // flashes open on the way.
    await page.locator(RAIL).getByRole('link', { name: n.bookings }).click();
    await expect(page).toHaveURL(/\/me\/bookings$/);
    await expect(aside).toHaveAttribute('data-collapsed', 'true');
  });

  test('coach: a player’s rail, until the coach module ships its own', async ({
    coachPage: page,
  }) => {
    await page.goto('/venues');
    await expect(page.locator(RAIL).getByRole('link')).toHaveText([n.play, n.bookings, n.profile]);
  });

  test('moderator: Платформа in the rail, into the platform and back out', async ({
    playerPage: page,
    player,
    isolatedTenant,
  }) => {
    await grantModerator(player.userId, isolatedTenant.userId);
    await page.goto('/venues');
    const rail = page.locator(RAIL);
    await expect(rail.getByText(n.platform)).toBeVisible();
    await expect(rail.getByRole('link')).toHaveText([
      n.play,
      n.bookings,
      n.profile,
      n.moderation,
      n.security,
    ]);
    await rail.getByRole('link', { name: n.moderation }).click();
    await expect(page).toHaveURL(/\/platform\/moderation$/);
    await expect(page.locator('main h1')).toHaveText(bg.platform.moderation.title);

    // And back to the site (#347): Играй.
    await page.getByTestId('shell-public-link').click();
    await expect(page).toHaveURL(/\/venues$/);
    await expect(page.locator(RAIL).getByRole('link', { name: n.moderation })).toBeVisible();
  });

  test('club account on /venues: its admin’s rail, never a player’s', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    const slug = isolatedTenant.tenantSlug;
    await page.goto('/venues');
    const rail = page.locator(RAIL);
    await expect(rail.getByRole('link', { name: n.calendar })).toHaveAttribute(
      'href',
      `/t/${slug}/admin/calendar`,
    );
    await expect(rail.getByRole('link', { name: n.play })).toHaveCount(0);
    await expect(rail.getByRole('link', { name: n.bookings })).toHaveCount(0);
    await expect(page.getByTestId('shell-context-name')).toHaveAttribute(
      'href',
      `/t/${slug}/admin`,
    );
    await expect(page.getByTestId('site-header-admin')).toHaveCount(0);

    await openMenu(page);
    await expect(page.locator(MENU_ROWS)).toHaveText([n.publicPage, n.profile, bg.common.signOut]);

    // A club account cannot book, so Резервации is not its page (audit C12).
    await page.goto('/me/bookings');
    await expect(page).toHaveURL(new RegExp(`/t/${slug}/admin/calendar$`));
  });

  test('club account: public → admin → public, one rail throughout', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    const slug = isolatedTenant.tenantSlug;
    await page.goto('/venues');
    await page.locator(RAIL).getByRole('link', { name: n.calendar }).click();
    await expect(page).toHaveURL(new RegExp(`/t/${slug}/admin/calendar$`));
    await expect(page.locator('main h1')).toHaveText(bg.admin.calendar.title);

    await page.getByTestId('shell-public-link').click();
    // The club's own page (#356), in the same frame.
    await expect(page).toHaveURL(new RegExp(`/clubs/${slug}$`));
    await expect(page.locator(RAIL).getByRole('link', { name: n.calendar })).toBeVisible();
  });

  test('/login does not link to itself (#319, audit A05)', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator(PUBLIC_NAV).getByRole('link', { name: n.play })).toBeVisible();
    await expect(page.locator('header a[href="/login"]')).toHaveCount(0);
  });

  test('the 404 wears the frame: the header for a visitor (audit A06)', async ({ page }) => {
    const res = await page.goto('/no-such-page');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: bg.notFound.title })).toBeAttached();
    await expect(page.locator(PUBLIC_NAV).getByRole('link', { name: n.play })).toBeVisible();
    const main = page.locator('main');
    await expect(main.getByRole('link', { name: bg.notFound.backToVenues })).toHaveAttribute(
      'href',
      '/venues',
    );
    await expect(main.getByRole('link', { name: bg.notFound.home })).toHaveAttribute('href', '/');
  });

  test('the 404 wears the frame: the rail for a player', async ({ playerPage: page }) => {
    const res = await page.goto('/no-such-page');
    expect(res?.status()).toBe(404);
    await expect(page.locator(RAIL).getByRole('link')).toHaveText([n.play, n.bookings, n.profile]);
    await expect(
      page.locator('main').getByRole('link', { name: bg.notFound.backToVenues }),
    ).toBeVisible();
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`axe, ${theme}: the player shell on /venues, best practice included`, async ({
      playerPage: page,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto('/venues');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.getByRole('heading', { level: 1, name: bg.venues.title })).toBeVisible();
      await expect(page.locator('main')).toHaveCount(1);
      await expectAxeClean(page);
    });

    test(`axe, ${theme}: a club account’s frame on /venues`, async ({
      authedPage: page,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto('/venues');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.getByRole('heading', { level: 1, name: bg.venues.title })).toBeVisible();
      await expectAxeClean(page);
    });
  }
});
