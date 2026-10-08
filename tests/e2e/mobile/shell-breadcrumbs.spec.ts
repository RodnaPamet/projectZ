import bg from '../../../messages/bg.json';
import { expect, test } from '../fixtures';

/**
 * The top bar's left slot on a 393 px phone (#362, owner 2026-10-08): the
 * brand mark, as upstream's `TopChrome` keeps it below `md`, and no trail in
 * the bar. Where a page has no way back of its own (the club admin's and the
 * platform's pages), it draws its trail inline, as upstream's pages do
 * (`PageBreadcrumbs`). The top of a section (Играй, Резервации, Профил) and a
 * page with its own back link (a venue, a club, a booking) do not: the title,
 * or the link, already says it. The desktop half is
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
});
