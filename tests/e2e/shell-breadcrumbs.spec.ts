import type { Page } from '@playwright/test';

import bg from '../../messages/bg.json';

import { expect, test } from './fixtures';
import { grantModerator } from './utils/create-player';

/**
 * The top bar's left slot at 1280 px (#362, owner 2026-10-08): the page's
 * breadcrumbs, where upstream's `TopChrome` has them, and no wordmark. The
 * sidebar's header names the app (or the club, or the platform), so the name
 * is on screen once. The phone half is tests/e2e/mobile/shell-breadcrumbs.spec.ts.
 */
test.use({ viewport: { width: 1280, height: 800 } });

const n = bg.common.nav;
const TRAIL = '[data-testid="top-chrome-breadcrumbs"]';

/** The top bar's trail, crumb by crumb, once it reads `expected`. */
async function expectTrail(page: Page, expected: string[]) {
  const trail = page.locator('header').locator(TRAIL);
  await expect(trail).toBeVisible();
  await expect(trail.getByRole('listitem')).toHaveText(
    expected.map((label, i) => (i < expected.length - 1 ? `${label}/` : label)),
  );
  return trail;
}

async function expectOneName(page: Page, name: string) {
  // The top bar's wordmark is the phone's; from md the sidebar names the app.
  await expect(page.getByTestId('shell-wordmark')).toBeHidden();
  await expect(page.getByText(name, { exact: true }).filter({ visible: true })).toHaveCount(1);
}

test.describe('the trail in the top bar — desktop', () => {
  test('player: Играй, then Играй / the venue, and back through the crumb', async ({
    playerPage: page,
  }) => {
    await page.goto('/venues');
    await expectTrail(page, [n.play]);
    await expectOneName(page, bg.common.appName);

    await page
      .locator('main')
      .getByRole('link', { name: /Sofia Padel Club/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/venues\/sofia-padel-club/);
    const trail = await expectTrail(page, [n.play, 'Sofia Padel Club']);
    await expect(trail.locator('[aria-current="page"]')).toHaveText('Sofia Padel Club');
    await expectOneName(page, bg.common.appName);

    await trail.getByRole('link', { name: n.play }).click();
    await expect(page).toHaveURL(/\/venues$/);
    await expectTrail(page, [n.play]);
  });

  test('player: Резервации and Профил name themselves', async ({ playerPage: page }) => {
    await page.goto('/me/bookings');
    await expectTrail(page, [n.bookings]);
    await page.goto('/me/profile');
    await expectTrail(page, [n.profile]);
  });

  test('club admin: Администрация / Кортове, and the crumb leads home', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    const slug = isolatedTenant.tenantSlug;
    await page.goto(`/t/${slug}/admin/courts`);
    const trail = await expectTrail(page, [n.admin, n.courts]);
    // The club's name is the sidebar's; the wordmark is not on a desktop.
    await expect(page.getByTestId('shell-wordmark')).toBeHidden();
    await expect(page.locator('aside').getByTestId('sidebar-collapse-toggle')).toContainText(
      `E2E ${slug}`,
    );

    await trail.getByRole('link', { name: n.admin }).click();
    await expect(page).toHaveURL(new RegExp(`/t/${slug}/admin$`));
    await expect(
      page.getByRole('heading', { level: 1, name: bg.admin.home.title, exact: true }),
    ).toBeVisible();
    await expectTrail(page, [n.admin]);
  });

  test('platform: Платформа / Модерация', async ({ playerPage: page, player, isolatedTenant }) => {
    await grantModerator(player.userId, isolatedTenant.userId);
    await page.goto('/platform/moderation');
    await expectTrail(page, [n.platform, n.moderation]);
    await expect(page.getByTestId('shell-wordmark')).toBeHidden();
  });
});
