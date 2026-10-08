import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import en from '../../../messages/en.json';
import { THEME_COOKIE } from '../../../src/lib/theme-constants';
import { expect, test } from '../fixtures';
import { grantModerator } from '../utils/create-player';

/**
 * The site's frames on a 393 px phone (#362): the bottom tab bar under the
 * thumb, and for a signed-in account the AppShell's hamburger and left drawer,
 * exactly as in the club admin.
 *
 *   signed out   Играй · Вход                     (the public header above)
 *   player,      Играй · Резервации · Профил      (Игри waits for its module),
 *   coach        and the drawer holds every item, Платформа included
 *   club         its admin's bar, Календар · Кортове · Играчи · Още, on public
 *                pages as in the admin
 *
 * Sideways scroll on these pages is horizontal-drift.spec.ts's job; this
 * checks the frame adds none, at the width it exists for.
 */

const TAB_BAR = `nav[aria-label="${bg.common.nav.tabBar}"]`;
const TABS = `${TAB_BAR} li > a, ${TAB_BAR} li > button`;
const DRAWER_NAV = `[data-testid="nav-drawer"] nav[aria-label="${bg.common.ui.mainNav}"]`;
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

/** axe over the bar alone, every rule including best practice. */
async function expectBarAxeClean(page: Page) {
  const results = await new AxeBuilder({ page })
    .include(TAB_BAR)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .analyze();
  const report = results.violations
    .map((v) => `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes[0]?.target.join(' ')}`)
    .join('\n');
  expect(results.violations, `axe found on the tab bar:\n${report}`).toEqual([]);
}

async function tabNames(page: Page): Promise<string[]> {
  return (await page.locator(TABS).allInnerTexts()).map((s) => s.trim());
}

/** Open the drawer from the top bar's hamburger. */
async function openDrawer(page: Page) {
  const toggle = page.getByTestId('nav-toggle');
  const box = (await toggle.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await toggle.tap();
  const drawer = page.getByRole('dialog', { name: n.menu });
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe('the frames — phone', () => {
  test('signed out: Играй and Вход, under the thumb', async ({ page }) => {
    await page.goto('/venues');
    const bar = page.locator(TAB_BAR);
    await expect(bar).toBeVisible();
    expect(await tabNames(page)).toEqual([n.play, n.signIn]);
    await expect(bar.getByRole('link', { name: n.play })).toHaveAttribute('aria-current', 'page');

    // The header's own links are the desktop's: one copy on a phone.
    await expect(page.getByRole('navigation', { name: bg.common.ui.mainNav })).toBeHidden();
    // No account: no bell, no hamburger, no drawer.
    await expect(page.getByTestId('header-notifications')).toHaveCount(0);
    await expect(page.getByTestId('nav-toggle')).toHaveCount(0);

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
    // The SHOWN bar: `/` wears its own layout's chrome (the (home) group), so
    // across this navigation the router may hold the previous page's copy
    // hidden beside the new one, and a bare selector matches both.
    const bar = page.locator(TAB_BAR).filter({ visible: true });
    await bar.getByRole('link', { name: n.play }).tap();
    await expect(page).toHaveURL(/\/venues$/);
    await expect(page.getByRole('heading', { level: 1, name: bg.venues.title })).toBeVisible();
    await expect(bar).toBeVisible();
    await expect(bar).toHaveCount(1);
  });

  test('is not on /login, where the page has one job', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: bg.login.title })).toBeVisible();
    await expect(page.locator(TAB_BAR)).toHaveCount(0);
  });

  test('player: Играй, Резервации, Профил; no Игри or Съобщения until their modules', async ({
    playerPage: page,
  }) => {
    await page.goto('/me/bookings');
    // By role, not `main h1`: under the 300 ms reveal throttle a streamed page
    // sits in a hidden copy beside the shown one, and `main h1` finds both.
    await expect(page.getByRole('heading', { level: 1, name: bg.myBookings.title })).toBeVisible();
    expect(await tabNames(page)).toEqual([n.play, n.bookings, n.profile]);
    await expect(page.locator(TAB_BAR).getByRole('link', { name: n.bookings })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The active tab carries the top accent bar, so it is never colour alone.
    await expect(
      page.locator(TAB_BAR).getByRole('link', { name: n.bookings }).locator('[data-tab-accent]'),
    ).toBeVisible();

    // The rail is the desktop's. The bell and the account menu are here, as
    // in every shell at every width (owner, 2026-10-08).
    await expect(page.locator('aside')).toBeHidden();
    await expect(page.getByTestId('top-chrome-user-menu')).toBeVisible();
    await expect(page.getByTestId('header-notifications')).toBeVisible();
    await expect(page.locator(TAB_BAR).getByRole('link', { name: n.games })).toHaveCount(0);
    await expect(page.locator('a[href^="/t/"]')).toHaveCount(0);

    await expectTargets(page);
    await expectNoDrift(page);
  });

  test('player: the hamburger’s drawer holds every item; a tap navigates and closes it', async ({
    playerPage: page,
  }) => {
    await page.goto('/venues');
    const drawer = await openDrawer(page);
    await expect(page.locator(DRAWER_NAV).getByRole('link')).toHaveText([
      n.play,
      n.bookings,
      n.profile,
    ]);
    // The rail's foot comes along: the player, and Изход.
    const foot = drawer.getByTestId('sidebar-account');
    await expect(foot.getByTestId('sidebar-identity')).toContainText(bg.admin.staff.role.PLAYER);
    await expect(foot.getByTestId('nav-logout')).toBeVisible();
    await expect(drawer.getByTestId('drawer-account')).toHaveCount(0);

    await page.locator(DRAWER_NAV).getByRole('link', { name: n.bookings }).tap();
    await expect(page).toHaveURL(/\/me\/bookings$/);
    await expect(page.getByRole('heading', { level: 1, name: bg.myBookings.title })).toBeVisible();
    await expect(page.locator('[data-testid="nav-drawer"]')).toHaveCount(0);
  });

  test('player: Escape closes the drawer and gives focus back to the hamburger', async ({
    playerPage: page,
  }) => {
    await page.goto('/venues');
    const toggle = page.getByTestId('nav-toggle');
    await toggle.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: n.menu });
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test('player: Профил is a page, with the language, the theme and a real Изход', async ({
    playerPage: page,
    player,
  }) => {
    await page.goto('/venues');
    await page.locator(TAB_BAR).getByRole('link', { name: n.profile }).tap();
    await expect(page).toHaveURL(/\/me\/profile$/);
    await expect(page.getByRole('heading', { level: 1, name: player.name })).toBeVisible();
    await expect(page.locator(TAB_BAR).getByRole('link', { name: n.profile })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByTestId('profile-language-row')).toBeVisible();
    await expect(page.getByTestId('profile-theme-row')).toBeVisible();
    await expect(page.getByTestId('profile-privacy-row')).toBeVisible();
    // No grant, no platform.
    await expect(page.getByTestId('profile-platform')).toHaveCount(0);

    await page.getByTestId('profile-sign-out').tap();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator(TAB_BAR).getByRole('link', { name: n.signIn })).toBeVisible();
  });

  test('player: the language is saved on the account and survives the next page', async ({
    playerPage: page,
  }) => {
    await page.goto('/me/profile');
    await page.getByTestId('profile-language-row').getByRole('radio', { name: 'English' }).tap();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // By test id: the bar's own name is English now too.
    const bar = page.getByTestId('bottom-tab-bar');
    await expect(bar).toHaveAttribute('aria-label', en.common.nav.tabBar);
    await expect(bar.getByRole('link', { name: en.common.nav.profile })).toBeVisible();

    // A new request: the middleware re-seeds the cookie from the token, which
    // now carries English too, so it does not flip back.
    await bar.getByRole('link', { name: en.common.nav.play }).tap();
    await expect(page).toHaveURL(/\/venues$/);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1, name: en.venues.title })).toBeVisible();
  });

  test('the bell opens "Нямате известия" as a sheet', async ({ playerPage: page }) => {
    await page.goto('/venues');
    const bell = page.getByTestId('header-notifications');
    await expect(bell).toHaveAccessibleName(n.notifications);
    // Polled: the vendored Popover picks its phone sheet after hydration and
    // re-mounts the trigger, so for a moment there is no box to measure.
    await expect
      .poll(async () => (await bell.boundingBox())?.width ?? 0)
      .toBeGreaterThanOrEqual(44);
    await bell.tap();
    await expect(page.getByTestId('notifications-empty')).toContainText(n.notificationsEmpty);
  });

  test('coach: a player’s bar and drawer', async ({ coachPage: page }) => {
    await page.goto('/venues');
    expect(await tabNames(page)).toEqual([n.play, n.bookings, n.profile]);
    await openDrawer(page);
    await expect(page.locator(DRAWER_NAV).getByRole('link')).toHaveText([
      n.play,
      n.bookings,
      n.profile,
    ]);
  });

  test('moderator: Платформа in the drawer leads into the platform', async ({
    playerPage: page,
    player,
    isolatedTenant,
  }) => {
    await grantModerator(player.userId, isolatedTenant.userId);
    await page.goto('/venues');
    const drawer = await openDrawer(page);
    // The section's title; the foot names the grant too.
    await expect(page.locator(DRAWER_NAV).getByText(n.platform)).toBeVisible();
    await expect(drawer.getByTestId('nav-admin-icon')).toHaveAttribute('href', '/platform');
    await page.locator(DRAWER_NAV).getByRole('link', { name: n.moderation }).tap();
    await expect(page).toHaveURL(/\/platform\/moderation$/);
    await expect(page.locator('main h1')).toHaveText(bg.platform.moderation.title);
  });

  test('moderator: Платформа on Профил leads there too', async ({
    playerPage: page,
    player,
    isolatedTenant,
  }) => {
    await grantModerator(player.userId, isolatedTenant.userId);
    await page.goto('/me/profile');
    // The shown row: a streamed page can sit in a hidden copy beside the shown
    // one under the 300 ms reveal throttle (#367).
    await page.getByTestId('profile-platform').filter({ visible: true }).tap();
    await expect(page).toHaveURL(/\/platform\/moderation$/);
    await expect(page.locator('main h1')).toHaveText(bg.platform.moderation.title);
  });

  test('club account on /venues: its admin’s bar and drawer, never a player’s', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    const slug = isolatedTenant.tenantSlug;
    await page.goto('/venues');
    await expect(page.getByRole('heading', { level: 1, name: bg.venues.title })).toBeVisible();
    expect(await tabNames(page)).toEqual([n.calendar, n.courts, n.players, n.more]);
    await expect(page.getByTestId('site-header-admin')).toHaveCount(0);

    const more = page.getByTestId('bottom-tab-more');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.tap();
    const drawer = page.getByRole('dialog', { name: n.menu });
    await expect(drawer.getByRole('link', { name: n.pricing })).toBeVisible();
    await expect(page.locator(DRAWER_NAV).getByRole('link', { name: n.play })).toHaveCount(0);
    await expect(
      drawer.getByTestId('drawer-account').getByRole('link', { name: n.publicPage }),
    ).toHaveAttribute('href', `/clubs/${slug}`);

    await expectTargets(page);
    await expectNoDrift(page);
  });

  test('club account: public → admin through its bar, admin → public through Още', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    const slug = isolatedTenant.tenantSlug;
    await page.goto('/venues');
    await page.locator(TAB_BAR).getByRole('link', { name: n.calendar }).tap();
    await expect(page).toHaveURL(new RegExp(`/t/${slug}/admin/calendar$`));
    await expect(page.locator(TAB_BAR).getByRole('link', { name: n.calendar })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await page.getByTestId('bottom-tab-more').tap();
    const drawer = page.getByRole('dialog', { name: n.menu });
    await drawer.getByRole('link', { name: n.publicPage }).tap();
    // The club's own page (#356), in the same frame.
    await expect(page).toHaveURL(new RegExp(`/clubs/${slug}$`));
    await expect(page.getByRole('heading', { level: 1, name: `E2E ${slug}` })).toBeVisible();
    expect(await tabNames(page)).toEqual([n.calendar, n.courts, n.players, n.more]);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`axe: signed out /venues, ${theme}`, async ({ page, baseURL }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto('/venues');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator(TAB_BAR)).toBeVisible();
      await expectAxeClean(page);
      await expectBarAxeClean(page);
    });

    test(`axe: player /me/profile, ${theme}`, async ({ playerPage: page, baseURL }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto('/me/profile');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator(TAB_BAR)).toBeVisible();
      await expectAxeClean(page);
      await expectBarAxeClean(page);
    });

    test(`axe: player /venues with the drawer open, ${theme}`, async ({
      playerPage: page,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto('/venues');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await openDrawer(page);
      await expect(page.locator(DRAWER_NAV).getByRole('link', { name: n.play })).toBeVisible();
      await expectAxeClean(page);
    });

    test(`axe: club account on /venues, ${theme}`, async ({ authedPage: page, baseURL }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto('/venues');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator(TAB_BAR)).toBeVisible();
      await expectAxeClean(page);
      await expectBarAxeClean(page);
    });
  }
});
