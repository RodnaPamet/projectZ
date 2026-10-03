import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import bg from '../../messages/bg.json';
import { THEME_COOKIE } from '../../src/lib/theme-constants';
import { expect, test as base } from './fixtures';
import { prisma } from './utils/create-isolated-tenant';

/**
 * The pricing board at 1280 px, as the club's OWNER (T24).
 *
 * The rule form's effect is a Combobox and its days a toggle row now, so a
 * rule is made the way a keyboard user makes one — type the name, Tab to a
 * day and press Space, open the effect with Enter, type, Enter — and then read
 * back from the database: a choice that looks made but posts nothing is the
 * failure a Combobox in place of a native select invites. Delete goes through
 * the confirm dialog. The phone half is tests/e2e/mobile/admin-pricing.spec.ts.
 */

const p = bg.admin.pricing;
const day = bg.common.calendar.weekdayShort;

interface Club {
  tenantId: string;
  slug: string;
  courtId: string;
}

/**
 * One venue, one court, one rule, in the spec's own club.
 *
 * `venue.tenantId` is not a foreign key, so it does not cascade from the club
 * `isolatedTenant` deletes: it goes here. Courts cascade from their venue and
 * rules from their court.
 */
const test = base.extend<{ club: Club }>({
  club: async ({ isolatedTenant }, use) => {
    const { tenantId, tenantSlug } = isolatedTenant;
    const courtId = await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      const venue = await tx.venue.create({
        data: {
          tenantId,
          slug: `${tenantSlug}-site`,
          name: 'Главен обект',
          addressLine: '1 Court St',
          city: 'Sofia',
          lat: 42.6977,
          lng: 23.3219,
          email: `${tenantSlug}-site@playerz.test`,
        },
      });
      const court = await tx.resource.create({
        data: {
          tenantId,
          venueId: venue.id,
          name: 'Корт 1',
          sport: 'PADEL',
          surface: 'ARTIFICIAL_GRASS',
          basePriceCents: 2400,
        },
      });
      await tx.pricingRule.create({
        data: {
          tenantId,
          resourceId: court.id,
          name: 'Уикенд',
          priority: 100,
          conditionsJson: { dayOfWeek: [6, 0] },
          fixedPriceCents: 4000,
        },
      });
      return court.id;
    });

    await use({ tenantId, slug: tenantSlug, courtId });

    await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      await tx.venue.deleteMany({ where: { tenantId } });
    });
  },
});

test.use({ viewport: { width: 1280, height: 900 } });

const ruleRow = (tenantId: string, name: string) =>
  prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return tx.pricingRule.findFirst({
      where: { tenantId, name },
      select: { priority: true, conditionsJson: true, multiplier: true, fixedPriceCents: true },
    });
  });

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

test.describe('club admin pricing — desktop', () => {
  test('creates a rule by keyboard: days, times and the effect', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/pricing`);
    await expect(page.locator('main select')).toHaveCount(0);
    await page.getByRole('button', { name: p.action.add }).click();

    // The RULE form: the page also carries the player-cancellation cutoff
    // form for an owner (#354), so `main form` alone is no longer one element.
    const form = page
      .locator('main form')
      .filter({ has: page.getByLabel(p.field.name, { exact: true }) });
    await form.getByLabel(p.field.name, { exact: true }).focus();
    await page.keyboard.type('Вечерен пик');
    await page.keyboard.press('Tab');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('250');

    // Tab into the day row; Tab moves along it and Space toggles.
    const days = form.getByRole('group', { name: p.field.days });
    await page.keyboard.press('Tab');
    await expect(days.getByRole('button', { name: day['1'] })).toBeFocused();
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(days.getByRole('button', { name: day['3'] })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(days.getByRole('button', { name: day['1'] })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(days.getByRole('button', { name: day['2'] })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    await form.getByLabel(p.field.from, { exact: true }).fill('18:00');
    await form.getByLabel(p.field.to, { exact: true }).fill('22:00');

    const effect = form.getByRole('combobox', { name: new RegExp(`^${p.field.effect},`) });
    await effect.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('option').first()).toBeVisible();
    await page.keyboard.type(p.effect.fixed);
    await page.keyboard.press('Enter');
    await expect(
      form.getByRole('combobox', { name: `${p.field.effect}, ${p.effect.fixed}` }),
    ).toBeVisible();
    await form.getByLabel(p.field.fixedPrice, { exact: true }).fill('31.50');
    await expectNoDrift(page);

    await form.getByRole('button', { name: p.action.add }).focus();
    await page.keyboard.press('Enter');

    await expect(form).toHaveCount(0);
    await expect(page.locator('main [data-perf-ready]')).toContainText('Вечерен пик');
    expect(await ruleRow(club.tenantId, 'Вечерен пик')).toEqual({
      priority: 250,
      conditionsJson: { dayOfWeek: [1, 3], timeRange: { from: '18:00', to: '22:00' } },
      multiplier: null,
      fixedPriceCents: 3150,
    });
    await expectNoDrift(page);
  });

  test('deletes a rule through the confirm, and it stays deleted', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/pricing`);
    const card = page.locator('main li', { hasText: 'Уикенд' });
    await expect(card).toHaveCount(1);

    await card.getByRole('button', { name: p.action.delete }).click();
    const dialog = page.getByRole('dialog', { name: p.delete.title });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Уикенд');
    await dialog.getByRole('button', { name: p.action.delete }).click();

    await expect(card).toHaveCount(0);
    await expect.poll(() => ruleRow(club.tenantId, 'Уикенд')).toBeNull();

    // Survives a reload: the server's answer, not the optimistic one.
    await page.reload();
    await expect(page.getByRole('main').getByText(p.empty.title)).toBeVisible();
    await expectNoDrift(page);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`axe: the board with the add form open, ${theme}`, async ({
      authedPage: page,
      club,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto(`/t/${club.slug}/admin/pricing`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.getByRole('button', { name: p.action.add }).click();
      // Court, preview day, and the form's effect.
      await expect(page.getByRole('combobox')).toHaveCount(3);
      await expectAxeClean(page);

      // And with the preview's day list open, which scrolls. As on the courts
      // board, the scroller is the combobox's own listbox, so axe's
      // `scrollable-region-focusable` passes without an exemption (#323).
      await page.getByRole('combobox', { name: new RegExp(`^${p.preview.day},`) }).click();
      await expect(page.getByRole('option').first()).toBeVisible();
      await expectAxeClean(page);
    });
  }
});
