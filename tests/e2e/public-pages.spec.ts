import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import bg from '../../messages/bg.json';
import { THEME_COOKIE } from '../../src/lib/theme-constants';

/**
 * The public pages at 1280 px, light and dark (T27): `/`, `/venues` and
 * `/login`, signed out — the shop window, in Bulgarian.
 *
 * tests/e2e/mobile/public-pages.spec.ts is the same at 393 px. Between them:
 * every page is axe-clean in both themes, none scrolls sideways, and each is
 * built from the primitives — the CTA is the primary button, the sport badges
 * are the catalogue's words, the sign-in heading is a heading.
 *
 * Asserted FROM THE CATALOGUE rather than retyped (see venue-discovery.spec.ts).
 */

const PAGES = [
  { path: '/', heading: 'playerz.bg' },
  { path: '/venues', heading: bg.venues.title },
  { path: '/login', heading: bg.login.title },
] as const;

/** Every Bulgarian sport name, and every enum value it replaced. */
const SPORT_NAMES = Object.values(bg.sports);
const SPORT_ENUMS = Object.keys(bg.sports);

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

async function expectNoDrift(page: Page) {
  const overflow = await page.evaluate(() =>
    Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth,
    ),
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe('public pages — desktop', () => {
  for (const theme of ['light', 'dark'] as const) {
    for (const { path, heading } of PAGES) {
      test(`${path}, ${theme}: axe-clean, no drift`, async ({ page, baseURL }) => {
        await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
        await page.goto(path);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();

        await expectAxeClean(page);
        await expectNoDrift(page);
      });
    }
  }

  test('/: the call to action is the primary button, and it leads to /venues', async ({ page }) => {
    await page.goto('/');
    const cta = page.getByRole('link', { name: bg.venues.title }).and(page.locator('main a'));
    await expect(cta).toHaveAttribute('href', '/venues');
    // The button recipe, not the #245 alias classes that drew a look-alike.
    await expect(cta).toHaveClass(/rounded-full/);
    await expect(cta).not.toHaveClass(/bg-bg-brand/);

    await cta.click();
    await expect(page).toHaveURL(/\/venues$/);
    await expect(page.getByRole('heading', { level: 1, name: bg.venues.title })).toBeVisible();
  });

  test('/venues: read again from /api/v1/venues after paint, with the sports in Bulgarian', async ({
    page,
  }) => {
    // The page paints its server seed, then the list revalidates it from the
    // endpoint the native app reads.
    const revalidated = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/v1/venues' && r.request().method() === 'GET',
    );
    await page.goto('/venues');
    const response = await revalidated;
    expect(response.status()).toBe(200);

    const cards = page.getByRole('main').getByRole('listitem');
    await expect(cards.first()).toBeVisible();

    // The seeded venues' sports are on their cards in the catalogue's words,
    // never `padel` or `table_tennis` — what `s.toLowerCase()` used to print.
    const seeded = cards.filter({ hasText: /Sofia|Plovdiv/ });
    await expect(seeded.first()).toBeVisible();
    for (const text of await seeded.allInnerTexts()) {
      expect(SPORT_NAMES.some((name) => text.includes(name))).toBe(true);
      for (const e of SPORT_ENUMS) expect(text).not.toMatch(new RegExp(`\\b${e.toLowerCase()}\\b`));
    }

    // #355: each card links to its venue page (#267 kept them plain text until
    // that page existed) — one link per card, named after the venue.
    for (const text of ['Sofia Padel Club', 'Plovdiv Tennis Center']) {
      await expect(
        cards.filter({ hasText: text }).getByRole('link', { name: text }),
      ).toHaveAttribute('href', /^\/venues\/[a-z0-9-]+$/);
    }
  });

  test('/venues?city=…: the filter is in the read, and the seed is that city', async ({ page }) => {
    const revalidated = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/v1/venues' && r.request().method() === 'GET',
    );
    await page.goto('/venues?city=Plovdiv');
    expect(new URL((await revalidated).url()).searchParams.get('city')).toBe('Plovdiv');

    const cards = page.getByRole('main').getByRole('listitem');
    await expect(cards.first()).toBeVisible();
    await expect(cards.filter({ hasText: 'Sofia' })).toHaveCount(0);
  });
});
