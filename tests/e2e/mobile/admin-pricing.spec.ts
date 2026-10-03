import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { THEME_COOKIE } from '../../../src/lib/theme-constants';
import { expect, test as base } from '../fixtures';
import { prisma } from '../utils/create-isolated-tenant';

/**
 * The pricing board on a 393 px phone, as the club's OWNER (T24): the same
 * create and delete as the desktop spec, checked for what a phone adds — the
 * Combobox opens as a bottom sheet, the seven day toggles fit one row as
 * 44 px targets, every other control is a 44 px target on a coarse pointer,
 * nothing drifts sideways with the form open, and axe passes in both themes.
 */

const p = bg.admin.pricing;
const day = bg.common.calendar.weekdayShort;

interface Club {
  tenantId: string;
  slug: string;
}

/** One venue, one court, one rule (see the desktop spec on teardown). */
const test = base.extend<{ club: Club }>({
  club: async ({ isolatedTenant }, use) => {
    const { tenantId, tenantSlug } = isolatedTenant;
    await prisma().$transaction(async (tx) => {
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
    });

    await use({ tenantId, slug: tenantSlug });

    await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      await tx.venue.deleteMany({ where: { tenantId } });
    });
  },
});

const ruleRow = (tenantId: string, name: string) =>
  prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return tx.pricingRule.findFirst({
      where: { tenantId, name },
      select: { conditionsJson: true, multiplier: true, fixedPriceCents: true },
    });
  });

async function expectTarget(target: Locator) {
  const box = (await target.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
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

test.describe('club admin pricing — phone', () => {
  test('creates a rule: day toggles in one row, the effect through the sheet', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/pricing`);
    await expectNoDrift(page);
    await expectTarget(page.getByRole('combobox', { name: new RegExp(`^${p.field.court},`) }));

    const add = page.getByRole('button', { name: p.action.add });
    await expectTarget(add);
    await add.click();

    // The RULE form: the page also carries the player-cancellation cutoff
    // form for an owner (#354), so `main form` alone is no longer one element.
    const form = page
      .locator('main form')
      .filter({ has: page.getByLabel(p.field.name, { exact: true }) });
    await form.getByLabel(p.field.name, { exact: true }).fill('Делнична сутрин');
    await expectNoDrift(page);

    // Seven 44 px toggles on ONE row: the same top for all of them.
    const days = form.getByRole('group', { name: p.field.days });
    const toggles = days.getByRole('button');
    await expect(toggles).toHaveCount(7);
    const tops = new Set<number>();
    for (const toggle of await toggles.all()) {
      const box = (await toggle.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(40);
      tops.add(Math.round(box.y));
    }
    expect(tops.size).toBe(1);

    await days.getByRole('button', { name: day['2'] }).click();
    await days.getByRole('button', { name: day['4'] }).click();
    await expect(days.getByRole('button', { name: day['4'] })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await form.getByLabel(p.field.from, { exact: true }).fill('07:00');
    await form.getByLabel(p.field.to, { exact: true }).fill('10:00');

    // The effect, tapped as a thumb would: the sheet opens, an option is picked.
    const effect = form.getByRole('combobox', { name: new RegExp(`^${p.field.effect},`) });
    await expectTarget(effect);
    await effect.click();
    await page.getByRole('option', { name: p.effect.multiplier, exact: true }).click();
    await expect(
      form.getByRole('combobox', { name: `${p.field.effect}, ${p.effect.multiplier}` }),
    ).toBeVisible();
    await form.getByLabel(p.field.multiplier, { exact: true }).fill('0.8');
    await expectNoDrift(page);

    const submit = form.getByRole('button', { name: p.action.add });
    await expectTarget(submit);
    await submit.click();

    await expect(form).toHaveCount(0);
    const saved = await ruleRow(club.tenantId, 'Делнична сутрин');
    expect(saved?.conditionsJson).toEqual({
      dayOfWeek: [2, 4],
      timeRange: { from: '07:00', to: '10:00' },
    });
    expect(Number(saved?.multiplier)).toBe(0.8);
    expect(saved?.fixedPriceCents).toBeNull();
    await expectNoDrift(page);
  });

  test('deletes a rule through the confirm', async ({ authedPage: page, club }) => {
    await page.goto(`/t/${club.slug}/admin/pricing`);
    const card = page.locator('main li', { hasText: 'Уикенд' });

    const del = card.getByRole('button', { name: p.action.delete });
    await expectTarget(del);
    await del.click();
    const dialog = page.getByRole('dialog', { name: p.delete.title });
    await expect(dialog).toBeVisible();
    await expectNoDrift(page);
    await dialog.getByRole('button', { name: p.action.delete }).click();

    await expect(card).toHaveCount(0);
    await expect.poll(() => ruleRow(club.tenantId, 'Уикенд')).toBeNull();
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
      await expect(page.getByRole('combobox')).toHaveCount(3);
      await expectAxeClean(page);
      await expectNoDrift(page);
    });
  }
});
