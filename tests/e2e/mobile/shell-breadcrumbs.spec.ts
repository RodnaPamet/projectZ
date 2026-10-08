import bg from '../../../messages/bg.json';
import { expect, test } from '../fixtures';
import { renameTenant } from '../utils/create-isolated-tenant';
import { grantModerator } from '../utils/create-player';
import { LONG_CLUB_NAME, leftSlotClearance } from '../utils/top-bar';

/**
 * The top bar's left slot on a 393 px phone (#362, owner 2026-10-08): the
 * brand mark, as upstream's `TopChrome` keeps it below `md`, and no trail in
 * the bar. Where a page has no way back of its own (the club admin's and the
 * platform's pages), it draws its trail inline, as upstream's pages do
 * (`PageBreadcrumbs`). The top of a section (Играй, Резервации, Профил) and a
 * page with its own back link (a venue, a club, a booking) do not: the title,
 * or the link, already says it. And nothing covers the mark: below `sm` the
 * club's (or the platform's) name leaves the bar for the drawer's header, as
 * upstream's switcher leaves it. The desktop half is
 * tests/e2e/shell-breadcrumbs.spec.ts.
 */

const n = bg.common.nav;
const BAR_TRAIL = 'header [data-testid="top-chrome-breadcrumbs"]';
const INLINE_TRAIL = '[data-testid="breadcrumbs"]';

test.describe('the top bar’s left slot — phone', () => {
  test('player on a venue: the wordmark in the bar, and the page’s own back link', async ({
    playerPage: page,
  }) => {
    await page.goto('/venues/sofia-padel-club');
    await expect(page.getByRole('heading', { level: 1, name: 'Sofia Padel Club' })).toBeVisible();

    const wordmark = page.getByTestId('shell-wordmark');
    await expect(wordmark).toBeVisible();
    await expect(wordmark).toHaveText(bg.common.appName);
    await expect.poll(() => leftSlotClearance(page)).toBeGreaterThanOrEqual(0);
    await expect(page.locator(BAR_TRAIL)).toBeHidden();
    await expect(page.locator('main').locator(INLINE_TRAIL).filter({ visible: true })).toHaveCount(
      0,
    );
    await expect(page.getByRole('link', { name: bg.venue.back })).toBeVisible();
  });

  test('player on Играй: the wordmark, and no trail at all', async ({ playerPage: page }) => {
    await page.goto('/venues');
    await expect(page.getByRole('heading', { level: 1, name: bg.venues.title })).toBeVisible();
    await expect(page.getByTestId('shell-wordmark')).toBeVisible();
    await expect(page.locator(BAR_TRAIL)).toBeHidden();
    await expect(page.locator('main').locator(INLINE_TRAIL).filter({ visible: true })).toHaveCount(
      0,
    );
  });

  test('club admin: the wordmark in the bar, the trail inline over the page', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    const slug = isolatedTenant.tenantSlug;
    await page.goto(`/t/${slug}/admin/courts`);
    await expect(page.getByTestId('shell-wordmark')).toBeVisible();
    await expect(page.locator(BAR_TRAIL)).toBeHidden();
    const inline = page.locator('main').locator(INLINE_TRAIL).filter({ visible: true });
    await expect(inline).toHaveCount(1);
    await expect(inline.getByRole('link', { name: n.admin })).toHaveAttribute(
      'href',
      `/t/${slug}/admin`,
    );
    await expect(inline.locator('[aria-current="page"]')).toHaveText(n.courts);
  });

  test('club admin, a long name: nothing covers the wordmark, and the drawer names the club', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    await renameTenant(isolatedTenant.tenantId, LONG_CLUB_NAME);
    await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
    await expect(
      page.getByRole('heading', { level: 1, name: bg.admin.courts.title, exact: true }),
    ).toBeVisible();

    await expect(page.getByTestId('shell-wordmark')).toBeVisible();
    // It covered the wordmark at every length on a phone, the fixture's own too.
    await expect(page.getByTestId('shell-context-name')).toBeHidden();
    await expect.poll(() => leftSlotClearance(page)).toBeGreaterThanOrEqual(0);

    await page.getByTestId('nav-toggle').tap();
    const drawer = page.getByRole('dialog', { name: n.menu });
    await expect(drawer.getByText(LONG_CLUB_NAME, { exact: true }).first()).toBeVisible();
  });

  test('platform: the wordmark, uncovered, and the trail inline over the page', async ({
    playerPage: page,
    player,
    isolatedTenant,
  }) => {
    await grantModerator(player.userId, isolatedTenant.userId);
    await page.goto('/platform/moderation');
    await expect(
      page.getByRole('heading', { level: 1, name: bg.platform.moderation.title, exact: true }),
    ).toBeVisible();

    await expect(page.getByTestId('shell-wordmark')).toBeVisible();
    await expect(page.getByTestId('shell-context-name')).toBeHidden();
    await expect.poll(() => leftSlotClearance(page)).toBeGreaterThanOrEqual(0);
    await expect(page.locator(BAR_TRAIL)).toBeHidden();
    const inline = page.locator('main').locator(INLINE_TRAIL).filter({ visible: true });
    await expect(inline.getByRole('link', { name: n.platform })).toHaveAttribute(
      'href',
      '/platform',
    );
    await expect(inline.locator('[aria-current="page"]')).toHaveText(n.moderation);
  });
});
