import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { THEME_COOKIE } from '../../../src/lib/theme-constants';
import { expect, test as base } from '../fixtures';
import { prisma } from '../utils/create-isolated-tenant';

/**
 * The courts board on a 393 px phone, as the club's OWNER (T23): the same add,
 * edit and archive as the desktop spec, checked for what a phone adds — the
 * Combobox opens as a bottom sheet, every control is a 44 px target on a
 * coarse pointer, nothing drifts sideways with the form open, and axe passes
 * in both themes.
 */

const c = bg.admin.courts;

interface Club {
  tenantId: string;
  slug: string;
}

/** One venue and one court with a booking ahead (see the desktop spec on teardown). */
const test = base.extend<{ club: Club }>({
  club: async ({ isolatedTenant }, use) => {
    const { tenantId, tenantSlug, userId } = isolatedTenant;
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
      const start = Date.now() + 2 * 86_400_000;
      await tx.booking.create({
        data: {
          tenantId,
          resourceId: court.id,
          bookedByUserId: userId,
          startTs: new Date(start),
          endTs: new Date(start + 3_600_000),
          status: 'CONFIRMED',
          totalCents: 2400,
          idempotencyKey: `e2e-courts-m-${tenantSlug}`,
        },
      });
    });

    await use({ tenantId, slug: tenantSlug });

    await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      await tx.booking.deleteMany({ where: { tenantId } });
      await tx.venue.deleteMany({ where: { tenantId } });
    });
  },
});

const courtRow = (tenantId: string, name: string) =>
  prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return tx.resource.findFirst({
      where: { tenantId, name },
      select: { sport: true, surface: true, status: true },
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

/**
 * Focus the field's trigger, open it with Enter, type, and pick with Enter.
 *
 * Below md the Combobox is a bottom sheet, and the sheet does not move focus
 * into its search box the way the desktop popover does — so the search box is
 * focused explicitly before typing (#323). Everything after that is the keyboard.
 */
async function chooseByKeyboard(page: Page, field: string, search: string, expected: string) {
  const trigger = page.getByRole('combobox', { name: new RegExp(`^${field},`) });
  await expectTarget(trigger);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.locator('[cmdk-input]').focus();
  await page.keyboard.type(search);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: `${field}, ${expected}` })).toBeVisible();
}

test.describe('club admin courts — phone', () => {
  test('adds a court through the sheet, with 44 px targets and no drift', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/courts`);
    await expectNoDrift(page);

    const add = page.getByRole('button', { name: c.action.add });
    await expectTarget(add);
    await add.click();

    const form = page.locator('form[data-perf-write="form"]');
    await form.getByLabel(c.field.name, { exact: true }).fill('Корт Е2Е');
    await expectNoDrift(page);

    // Tapped, as a thumb would: the sheet opens and an option is picked.
    const sport = page.getByRole('combobox', { name: new RegExp(`^${c.field.sport},`) });
    await expectTarget(sport);
    await sport.click();
    await page.getByRole('option', { name: bg.sports.TENNIS, exact: true }).click();
    await expect(
      page.getByRole('combobox', { name: `${c.field.sport}, ${bg.sports.TENNIS}` }),
    ).toBeVisible();

    // And by keyboard, which a phone with a paired keyboard still has.
    await chooseByKeyboard(page, c.field.surface, c.surface.CLAY, c.surface.CLAY);

    await expectTarget(page.getByRole('switch', { name: c.setting.indoor }).locator('..'));
    const submit = form.getByRole('button', { name: c.action.add });
    await expectTarget(submit);
    await expectNoDrift(page);
    await submit.click();

    await expect(form).toHaveCount(0);
    expect(await courtRow(club.tenantId, 'Корт Е2Е')).toMatchObject({
      sport: 'TENNIS',
      surface: 'CLAY',
    });
    await expectNoDrift(page);
  });

  test('edits a court and archives it through the confirm', async ({ authedPage: page, club }) => {
    await page.goto(`/t/${club.slug}/admin/courts`);
    const card = page.locator('main ul[data-perf-ready] > li').first();

    const edit = card.getByRole('button', { name: c.action.edit });
    await expectTarget(edit);
    await edit.click();
    await chooseByKeyboard(page, c.field.surface, c.surface.HARD, c.surface.HARD);
    await expectNoDrift(page);
    await card.getByRole('button', { name: c.action.save }).click();
    await expect(card.locator('form')).toHaveCount(0);
    expect(await courtRow(club.tenantId, 'Корт 1')).toMatchObject({ surface: 'HARD' });

    const archive = card.getByRole('button', { name: c.action.archive });
    await expectTarget(archive);
    await archive.click();
    const dialog = page.getByRole('dialog', { name: c.archive.title });
    await expect(dialog).toBeVisible();
    await expectNoDrift(page);
    await dialog.getByRole('button', { name: c.action.archive }).click();

    await expect(card.locator('[data-court-status]')).toHaveText(c.status.CLOSED);
    await expect.poll(async () => (await courtRow(club.tenantId, 'Корт 1'))?.status).toBe('CLOSED');
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`axe: the board with the add form open, ${theme}`, async ({
      authedPage: page,
      club,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto(`/t/${club.slug}/admin/courts`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.getByRole('button', { name: c.action.add }).click();
      await expect(page.getByRole('combobox')).toHaveCount(3);
      await expectAxeClean(page);
    });
  }
});
