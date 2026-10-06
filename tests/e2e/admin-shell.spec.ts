import AxeBuilder from '@axe-core/playwright';

import { THEME_COOKIE } from '../../src/lib/theme-constants';
import { UI_STORAGE_PREFIX } from '../../src/lib/ui-storage';
import bg from '../../messages/bg.json';

import { expect, test } from './fixtures';
import { prisma } from './utils/create-isolated-tenant';

/**
 * The club-admin shell at 1280 px, as the club's OWNER (T19).
 *
 * The sidebar is inflect's vendored frame with playerz's links; these check
 * the parts a desktop user touches. The phone half (drawer, 44 px hamburger)
 * is tests/e2e/mobile/admin-shell.spec.ts.
 */
test.use({ viewport: { width: 1280, height: 800 } });

const MAIN_NAV = `aside nav[aria-label="${bg.common.ui.mainNav}"]`;
const PAGES = ['calendar', 'courts', 'pricing', 'players', 'staff'] as const;
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
    const name = page.getByTestId('admin-context-name');
    await expect(name).toHaveText(`E2E ${isolatedTenant.tenantSlug}`);
    await expect(name).toHaveAttribute('href', `/t/${isolatedTenant.tenantSlug}/admin`);
    await expect(page.getByRole('combobox')).toHaveCount(0);
  });

  test('the way out (#347): the wordmark and "Публична страница" reach the public site', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
    await expect(page.getByTestId('admin-wordmark')).toHaveAttribute('href', '/');
    // No bottom bar on a desktop.
    await expect(page.locator(`nav[aria-label="${bg.common.nav.tabBar}"]`)).toBeHidden();

    const pub = page.getByTestId('admin-public-link');
    await expect(pub).toHaveText(bg.common.nav.publicPage);
    await pub.click();
    await expect(page).toHaveURL(/\/venues$/);

    // And the menu offers the same, with the profile.
    await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
    await page.getByTestId('top-chrome-user-menu').click();
    const menu = page.getByRole('menu', { name: bg.nav.accountMenu });
    await expect(menu.getByTestId('user-menu-public')).toHaveAttribute('href', '/venues');
    await expect(menu.getByTestId('user-menu-profile')).toHaveAttribute('href', '/me/profile');
  });

  test('"Публична страница" opens the club’s venue page once it has a live venue (#355)', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    // A live venue for this club; the database fills its publicSlug (P41).
    const venue = await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      const v = await tx.venue.create({
        data: {
          tenantId: isolatedTenant.tenantId,
          slug: `${isolatedTenant.tenantSlug}-venue`,
          name: `E2E venue ${isolatedTenant.tenantSlug}`,
          addressLine: 'ул. Корт 1',
          city: 'Sofia',
          lat: 42.6977,
          lng: 23.3219,
          email: `${isolatedTenant.tenantSlug}@playerz.test`,
          timezone: 'Europe/Sofia',
        },
      });
      return tx.venue.findUniqueOrThrow({
        where: { id: v.id },
        select: { id: true, publicSlug: true, name: true },
      });
    });

    try {
      await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
      const pub = page.getByTestId('admin-public-link');
      await expect(pub).toHaveAttribute('href', `/venues/${venue.publicSlug}`);
      await pub.click();
      await expect(page).toHaveURL(new RegExp(`/venues/${venue.publicSlug}(\\?|$)`));
      await expect(page.getByRole('heading', { level: 1, name: venue.name })).toBeVisible();
      // And back: the club account's way home from its own venue page.
      await page.getByTestId('site-header-admin').click();
      await expect(page).toHaveURL(new RegExp(`/t/${isolatedTenant.tenantSlug}/admin/calendar$`));
    } finally {
      // `venue.tenantId` is not a foreign key: the venue does not go with the club.
      await prisma().$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
        await tx.venue.deleteMany({ where: { id: venue.id } });
      });
    }
  });

  test('staff: only the pages the role opens, and a closed one is a 404 in the shell (S01)', async ({
    staffPage: page,
    isolatedTenant,
  }) => {
    const slug = isolatedTenant.tenantSlug;
    await page.goto(`/t/${slug}/admin`);
    await expect(page).toHaveURL(new RegExp(`/t/${slug}/admin/calendar$`));
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
    await page.getByRole('link', { name: bg.notFound.backToAdmin }).click();
    await expect(page).toHaveURL(new RegExp(`/t/${slug}/admin/calendar$`));
  });

  test('/t/{slug}/admin opens the first page the role may see (audit C10)', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    await page.goto(`/t/${isolatedTenant.tenantSlug}/admin`);
    await expect(page).toHaveURL(new RegExp(`/t/${isolatedTenant.tenantSlug}/admin/calendar$`));
    await expect(page.locator('main h1')).toHaveText(bg.admin.calendar.title);
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

  test('the account menu has the theme toggle and signs out', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
    await page.getByTestId('top-chrome-user-menu').click();
    await expect(page.getByTestId('user-menu-theme-row')).toBeVisible();
    await expect(page.getByTestId('user-menu-language-row')).toHaveCount(0);
    await page.getByTestId('user-menu-sign-out').click();
    await expect(page).toHaveURL(/\/$/);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`axe, ${theme}: no violations, best practice included (one <main>)`, async ({
      authedPage: page,
      isolatedTenant,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto(`/t/${isolatedTenant.tenantSlug}/admin/courts`);
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
