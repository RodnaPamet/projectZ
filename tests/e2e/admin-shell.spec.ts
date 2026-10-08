import AxeBuilder from '@axe-core/playwright';

import { THEME_COOKIE } from '../../src/lib/theme-constants';
import { UI_STORAGE_PREFIX } from '../../src/lib/ui-storage';
import bg from '../../messages/bg.json';

import { expect, test } from './fixtures';
import {
  clubPageToVenue,
  destroyClubVenue,
  expectAxeClean,
  seedClubVenue,
} from './utils/club-page-journey';

/**
 * The club-admin shell at 1280 px, as the club's OWNER (T19).
 *
 * The sidebar is inflect's vendored frame with playerz's links; these check
 * the parts a desktop user touches. The phone half (drawer, 44 px hamburger)
 * is tests/e2e/mobile/admin-shell.spec.ts.
 */
test.use({ viewport: { width: 1280, height: 800 } });

const MAIN_NAV = `aside nav[aria-label="${bg.common.ui.mainNav}"]`;
const PAGES = ['calendar', 'courts', 'pricing', 'photos', 'players', 'staff', 'reports'] as const;
const COLLAPSE_KEY = `${UI_STORAGE_PREFIX}:sidebar-collapsed`;

test.describe('club admin shell — desktop', () => {
  test('the sidebar links every admin page, and no switcher', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
    const nav = page.locator(MAIN_NAV);
    await expect(nav).toBeVisible();

    for (const p of PAGES) {
      await expect(
        nav.locator(`a[href="/t/${isolatedTenant.tenantSlug}/admin/${p}"]`),
      ).toBeVisible();
    }
    await expect(nav.getByRole('link')).toHaveCount(PAGES.length);

    // Every label is whole at 1280 px: "Ценообразуване" was cut to
    // "Ценообразува…" by the vendored rail's width (audit C09).
    const clipped = await nav.evaluate((el) =>
      [...el.querySelectorAll('a *')]
        .filter((n) => n.childElementCount === 0 && (n.textContent ?? '').trim() !== '')
        .filter((n) => n.scrollWidth > n.clientWidth + 1)
        .map((n) => n.textContent),
    );
    expect(clipped).toEqual([]);

    // #263: one account, one club. The club's name is not a picker; since #347
    // it is the link back to the admin's start, and nothing to switch.
    const name = page.getByTestId('shell-context-name');
    await expect(name).toHaveText(`E2E ${isolatedTenant.tenantSlug}`);
    await expect(name).toHaveAttribute('href', `/t/${isolatedTenant.tenantSlug}/admin`);
    await expect(page.getByRole('combobox')).toHaveCount(0);
  });

  test('the way out (#347): the wordmark and "Публична страница" reach the public site', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    const slug = isolatedTenant.tenantSlug;
    await page.goto(`/t/${slug}/admin/courts`);
    // Играй: where `/` sends anybody signed in (#362), linked directly.
    await expect(page.getByTestId('shell-wordmark')).toHaveAttribute('href', '/venues');
    // No bottom bar on a desktop.
    await expect(page.locator(`nav[aria-label="${bg.common.nav.tabBar}"]`)).toBeHidden();

    // The club's own page (#356), even before it has a venue: it says so.
    const pub = page.getByTestId('shell-public-link');
    await expect(pub).toHaveText(bg.common.nav.publicPage);
    await pub.click();
    await expect(page).toHaveURL(new RegExp(`/clubs/${slug}$`));
    await expect(page.getByRole('heading', { level: 1, name: `E2E ${slug}` })).toBeVisible();
    await expect(page.getByText(bg.club.noVenues.title)).toBeVisible();

    // The account menu is every shell's (owner, 2026-10-08): the profile and
    // sign-out, under the theme and the language.
    await page.goto(`/t/${slug}/admin/courts`);
    await page.getByTestId('top-chrome-user-menu').click();
    const menu = page.getByRole('menu', { name: bg.nav.accountMenu });
    await expect(menu.getByTestId('user-menu-profile')).toHaveAttribute('href', '/me/profile');
    await expect(menu.getByRole('menuitem')).toHaveText([bg.common.nav.profile, bg.common.signOut]);
  });

  test('"Публична страница" → the club page → its venue (#356)', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    const slug = isolatedTenant.tenantSlug;
    const venue = await seedClubVenue(isolatedTenant.tenantId, slug);
    try {
      await page.goto(`/t/${slug}/admin/courts`);
      await page.getByTestId('shell-public-link').click();
      await expect(page).toHaveURL(new RegExp(`/clubs/${slug}$`));
      // The page's title streams in after its body (Next's async metadata),
      // and axe's document-title rule reads it: settle on it first.
      await expect(page).toHaveTitle(new RegExp(`E2E ${slug}`));
      await expectAxeClean(page);
      await clubPageToVenue(page, `E2E ${slug}`, venue);
      // And back: the club account wears its admin's frame on its own venue
      // page too (#362), so its rail is the way home.
      await page
        .locator(`aside nav[aria-label="${bg.common.ui.mainNav}"]`)
        .getByRole('link', { name: bg.common.nav.calendar })
        .click();
      await expect(page).toHaveURL(new RegExp(`/t/${slug}/admin/calendar$`));
    } finally {
      await destroyClubVenue(venue);
    }
  });

  test('staff: only the pages the role opens, and a closed one is a 404 in the shell (S01)', async ({
    staffPage: page,
    isolatedTenant,
  }) => {
    const slug = isolatedTenant.tenantSlug;
    // The club admin's home offers staff its two pages, as the rail does.
    await page.goto(`/t/${slug}/admin`);
    await expect(page.locator('main h1')).toHaveText(bg.admin.home.title);
    await expect(page.locator('main').getByRole('link')).toHaveText([
      bg.common.nav.calendar,
      bg.common.nav.players,
    ]);
    const nav = page.locator(MAIN_NAV);
    await expect(nav.getByRole('link')).toHaveCount(2);
    await expect(nav.locator(`a[href="/t/${slug}/admin/calendar"]`)).toBeVisible();
    await expect(nav.locator(`a[href="/t/${slug}/admin/players"]`)).toBeVisible();

    // By URL: the app's not-found, INSIDE the admin shell, not a bare page.
    await page.goto(`/t/${slug}/admin/courts`);
    await expect(page.getByTestId('shell-not-found')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: bg.notFound.title })).toBeAttached();
    await expect(page.locator(MAIN_NAV)).toBeVisible();
    await expect(page.locator('main')).toHaveCount(1);
    // "Към админа на клуба": the club admin's home.
    await page.getByRole('link', { name: bg.notFound.backToAdmin }).click();
    await expect(page).toHaveURL(new RegExp(`/t/${slug}/admin$`));
    await expect(page.locator('main h1')).toHaveText(bg.admin.home.title);
  });

  test('the foot’s gear opens the club admin’s home: the theme, and every page the role opens', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    const slug = isolatedTenant.tenantSlug;
    await page.goto(`/t/${slug}/admin/courts`);
    const foot = page.locator('aside').getByTestId('sidebar-account');
    await expect(foot).toContainText(`E2E ${slug}`);
    await expect(foot).toContainText(bg.admin.staff.role.OWNER);
    await foot.locator('#admin-icon-link-desktop').click();

    // Not a 404 (audit C10), and not a redirect any more: a page of its own.
    await expect(page).toHaveURL(new RegExp(`/t/${slug}/admin$`));
    await expect(page.locator('main h1')).toHaveText(bg.admin.home.title);
    await expect(page.locator('#admin-theme-toggle')).toBeVisible();
    const pages = page.locator('main').getByRole('link');
    await expect(pages).toHaveText([
      bg.common.nav.calendar,
      bg.common.nav.courts,
      bg.common.nav.pricing,
      bg.common.nav.photos,
      bg.common.nav.players,
      bg.common.nav.staff,
      bg.common.nav.reports,
    ]);
    await pages.filter({ hasText: bg.common.nav.pricing }).click();
    await expect(page).toHaveURL(new RegExp(`/t/${slug}/admin/pricing$`));
  });

  test('the club admin’s home switches the theme', async ({ authedPage: page, isolatedTenant }) => {
    await page.goto(`/t/${isolatedTenant.tenantSlug}/admin`);
    const html = page.locator('html');
    const before = await html.getAttribute('data-theme');
    const after = before === 'dark' ? 'light' : 'dark';
    await page.locator('#admin-theme-toggle').click();
    await expect(html).toHaveAttribute('data-theme', after);
  });

  test('collapses to an icon rail, and remembers it across a reload', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
    const rail = page.locator('aside[data-collapsed]');
    await expect(rail).toHaveAttribute('data-collapsed', 'false');

    // The upstream 28 px control footprint, not the 24 px it shipped with (#317).
    const toggle = page.getByTestId('sidebar-collapse-toggle');
    expect((await toggle.boundingBox())?.height).toBeGreaterThanOrEqual(28);
    await toggle.click();
    await expect(rail).toHaveAttribute('data-collapsed', 'true');
    expect(await page.evaluate((k) => localStorage.getItem(k), COLLAPSE_KEY)).toBe('true');

    await page.reload();
    await expect(page.locator('aside[data-collapsed]')).toHaveAttribute('data-collapsed', 'true');
    // Collapsed rows keep their names, as tooltips' accessible labels.
    await expect(
      page.locator(MAIN_NAV).getByRole('link', { name: bg.common.nav.pricing }),
    ).toBeVisible();
  });

  test('the nav works from the keyboard', async ({ authedPage: page, isolatedTenant }) => {
    await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
    const pricing = page.locator(MAIN_NAV).getByRole('link', { name: bg.common.nav.pricing });
    await expect(pricing).toBeVisible();

    // Tab until the pricing link has focus; a nav reachable only by mouse fails here.
    for (
      let i = 0;
      i < 20 && !(await pricing.evaluate((el) => el === document.activeElement));
      i++
    ) {
      await page.keyboard.press('Tab');
    }
    await expect(pricing).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/t/${isolatedTenant.tenantSlug}/admin/pricing$`));
    await expect(page.locator('main h1')).toHaveText(bg.admin.pricing.title);
  });

  test('the account menu has the theme and the language, and signs out', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
    await page.getByTestId('top-chrome-user-menu').click();
    await expect(page.getByTestId('user-menu-theme-row')).toBeVisible();
    await expect(page.getByTestId('user-menu-language-row')).toBeVisible();
    await page.getByTestId('user-menu-sign-out').click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('the sidebar’s foot signs out too', async ({ authedPage: page, isolatedTenant }) => {
    await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
    await page.locator('aside').getByTestId('nav-logout').click();
    await expect(page).toHaveURL(/\/$/);
  });

  for (const [theme, path, what] of [
    ['light', 'courts', 'a page'],
    ['dark', 'courts', 'a page'],
    ['light', '', 'the club admin’s home'],
    ['dark', '', 'the club admin’s home'],
  ] as const) {
    test(`axe, ${theme}, ${what}: no violations, best practice included (one <main>)`, async ({
      authedPage: page,
      isolatedTenant,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto(`/t/${isolatedTenant.tenantSlug}/admin${path ? `/${path}` : ''}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('main h1')).toBeVisible();

      // The shell renders the only <main>; a page that adds its own fails
      // best-practice's landmark rules, which is why those tags are on.
      await expect(page.locator('main')).toHaveCount(1);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        // No rule off. `landmark-banner-is-top-level` used to be: the vendored
        // AppShellFrame put the top bar inside its <main> until upstream #3104.
        .analyze();
      const report = results.violations
        .map((v) => `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes[0]?.target.join(' ')}`)
        .join('\n');
      expect(results.violations, `axe found:\n${report}`).toEqual([]);
    });
  }
});
