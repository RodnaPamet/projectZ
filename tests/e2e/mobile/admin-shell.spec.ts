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
const TAB_BAR = `nav[aria-label="${bg.common.nav.tabBar}"]`;
const n = bg.common.nav;

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

    const drawer = page.getByRole('dialog', { name: bg.common.nav.menu });
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

  test('owner: the bottom bar is Календар, Кортове, Играчи, Още (#362)', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    const slug = isolatedTenant.tenantSlug;
    await page.goto(`/t/${slug}/admin/courts`);
    const bar = page.locator(TAB_BAR);
    await expect(bar).toBeVisible();
    await expect(bar.locator('li > a, li > button')).toHaveText([
      n.calendar,
      n.courts,
      n.players,
      n.more,
    ]);
    const courts = bar.getByRole('link', { name: n.courts });
    await expect(courts).toHaveAttribute('aria-current', 'page');
    await expect(courts.locator('[data-tab-accent]')).toBeVisible();

    // Fixed to the bottom, every target 44 px, nothing sideways.
    const box = (await bar.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(page.viewportSize()!.height);
    for (const el of await bar.locator('li > a, li > button').all()) {
      const b = (await el.boundingBox())!;
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await bar.getByRole('link', { name: n.players }).tap();
    await expect(page).toHaveURL(new RegExp(`/t/${slug}/admin/players$`));
    await expect(bar.getByRole('link', { name: n.players })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('Още opens the drawer: the long tail, then Публична страница, Профил, Изход', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/calendar`);
    const more = page.getByTestId('bottom-tab-more');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.tap();
    await expect(more).toHaveAttribute('aria-expanded', 'true');

    const drawer = page.getByRole('dialog', { name: n.menu });
    await expect(drawer.getByRole('link', { name: n.pricing })).toBeVisible();
    await expect(drawer.getByRole('link', { name: n.staff })).toBeVisible();
    const account = drawer.getByTestId('drawer-account');
    await expect(account.getByRole('link', { name: n.publicPage })).toHaveAttribute(
      'href',
      `/clubs/${isolatedTenant.tenantSlug}`,
    );
    await expect(account.getByRole('link', { name: n.profile })).toHaveAttribute(
      'href',
      '/me/profile',
    );
    const signOut = account.getByRole('button', { name: bg.common.signOut });
    await expect(signOut).toBeVisible();
    await signOut.tap();
    await expect(page).toHaveURL(/\/$/);
  });

  test('staff: Календар, Играчи, Още, and no page staff cannot open', async ({
    staffPage: page,
    isolatedTenant,
  }) => {
    const slug = isolatedTenant.tenantSlug;
    await page.goto(`/t/${slug}/admin/calendar`);
    const bar = page.locator(TAB_BAR);
    await expect(bar.locator('li > a, li > button')).toHaveText([n.calendar, n.players, n.more]);

    await page.getByTestId('bottom-tab-more').tap();
    const drawer = page.getByRole('dialog', { name: n.menu });
    for (const closed of [n.courts, n.pricing, n.staff]) {
      await expect(drawer.getByRole('link', { name: closed })).toHaveCount(0);
    }
    await page.keyboard.press('Escape');

    // A closed page by URL: the 404 inside the shell, with the bar still there.
    await page.goto(`/t/${slug}/admin/pricing`);
    await expect(page.getByTestId('shell-not-found')).toBeVisible();
    await expect(bar).toBeVisible();
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`axe, ${theme}: the bottom bar, best practice included (#362)`, async ({
      authedPage: page,
      isolatedTenant,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator(TAB_BAR)).toBeVisible();
      // The page itself, not its loading skeleton, which has no h1.
      await expect(page.locator('main h1')).toHaveText(bg.admin.courts.title);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        .analyze();
      const report = results.violations
        .map((v) => `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes[0]?.target.join(' ')}`)
        .join('\n');
      expect(results.violations, `axe found:\n${report}`).toEqual([]);
    });

    test(`axe, ${theme}: the drawer open (#317)`, async ({
      authedPage: page,
      isolatedTenant,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.getByTestId('nav-toggle').tap();
      const drawer = page.getByRole('dialog', { name: bg.common.nav.menu });
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
