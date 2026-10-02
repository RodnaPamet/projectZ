import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import bg from '../../messages/bg.json';
import { THEME_COOKIE } from '../../src/lib/theme-constants';
import { expect, test as base } from './fixtures';
import { prisma } from './utils/create-isolated-tenant';

/**
 * The courts board at 1280 px, as the club's OWNER (T23).
 *
 * The form's choices are Comboboxes now, so these drive them the way a
 * keyboard user does — focus the trigger, Enter, type, Enter — and then read
 * the court back from the database: a choice that looks made but posts
 * nothing is the failure a Combobox in place of a native select invites.
 * Archiving goes through the confirm dialog. The phone half is
 * tests/e2e/mobile/admin-courts.spec.ts.
 */

const c = bg.admin.courts;

interface Club {
  tenantId: string;
  slug: string;
  courtId: string;
}

/**
 * One venue and one court with a booking ahead, in the spec's own club.
 *
 * `venue.tenantId` and `booking.tenantId` are not foreign keys, so neither
 * cascades from the club `isolatedTenant` deletes: they go here, first.
 * Courts cascade from their venue.
 */
const test = base.extend<{ club: Club }>({
  club: async ({ isolatedTenant }, use) => {
    const { tenantId, tenantSlug, userId } = isolatedTenant;
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
          idempotencyKey: `e2e-courts-${tenantSlug}`,
        },
      });
      return court.id;
    });

    await use({ tenantId, slug: tenantSlug, courtId });

    await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      await tx.booking.deleteMany({ where: { tenantId } });
      await tx.venue.deleteMany({ where: { tenantId } });
    });
  },
});

test.use({ viewport: { width: 1280, height: 900 } });

const courtRow = (tenantId: string, name: string) =>
  prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return tx.resource.findFirst({
      where: { tenantId, name },
      select: { sport: true, surface: true, isIndoor: true, status: true },
    });
  });

/** Focus the field's trigger, open it with Enter, type, and pick with Enter. */
async function chooseByKeyboard(page: Page, field: string, search: string, expected: string) {
  const trigger = page.getByRole('combobox', { name: new RegExp(`^${field},`) });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.keyboard.type(search);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: `${field}, ${expected}` })).toBeVisible();
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

async function expectAxeClean(page: Page, opts: { disableRules?: string[] } = {}) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .disableRules(opts.disableRules ?? [])
    .analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  const report = blocking
    .map((v) => `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes[0]?.target.join(' ')}`)
    .join('\n');
  expect(blocking, `axe found ${blocking.length} blocking violation(s):\n${report}`).toEqual([]);
}

test.describe('club admin courts — desktop', () => {
  test('adds a court, choosing sport and surface by keyboard', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/courts`);
    await page.getByRole('button', { name: c.action.add }).click();

    const form = page.locator('form[data-perf-write="form"]');
    await expect(form.locator('select')).toHaveCount(0);
    await form.getByLabel(c.field.name, { exact: true }).fill('Корт Е2Е');
    await chooseByKeyboard(page, c.field.sport, bg.sports.TENNIS, bg.sports.TENNIS);
    await chooseByKeyboard(page, c.field.surface, c.surface.CLAY, c.surface.CLAY);
    await page.getByRole('switch', { name: c.setting.indoor }).click();
    await form.getByRole('button', { name: c.action.add }).click();

    await expect(form).toHaveCount(0);
    await expect(page.locator('main ul[data-perf-ready] > li h2')).toContainText(['Корт Е2Е']);
    expect(await courtRow(club.tenantId, 'Корт Е2Е')).toEqual({
      sport: 'TENNIS',
      surface: 'CLAY',
      isIndoor: true,
      status: 'ACTIVE',
    });
    await expectNoDrift(page);
  });

  test('edits a court: the surface changes by keyboard and is saved', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/courts`);
    const card = page.locator('main ul[data-perf-ready] > li').first();
    await card.getByRole('button', { name: c.action.edit }).click();

    // The edit form opens on the court's own values, in Bulgarian.
    await expect(
      card.getByRole('combobox', { name: `${c.field.sport}, ${bg.sports.PADEL}` }),
    ).toBeVisible();
    await chooseByKeyboard(page, c.field.surface, c.surface.HARD, c.surface.HARD);
    await card.getByRole('button', { name: c.action.save }).click();

    await expect(card.locator('form')).toHaveCount(0);
    expect(await courtRow(club.tenantId, 'Корт 1')).toMatchObject({
      sport: 'PADEL',
      surface: 'HARD',
    });
  });

  test('archives through the confirm, flips at once, and reopens', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/courts`);
    const card = page.locator('main ul[data-perf-ready] > li').first();
    const status = card.locator('[data-court-status]');
    await expect(status).toHaveText(c.status.ACTIVE);

    await card.getByRole('button', { name: c.action.archive }).click();
    const dialog = page.getByRole('dialog', { name: c.archive.title });
    await expect(dialog).toBeVisible();
    // The booking ahead is counted, and the dialog says archiving keeps it.
    await expect(dialog).toContainText('1');
    await dialog.getByRole('button', { name: c.action.archive }).click();

    await expect(status).toHaveText(c.status.CLOSED);
    await expect(card.getByRole('button', { name: c.action.reopen })).toBeVisible();
    await expect.poll(async () => (await courtRow(club.tenantId, 'Корт 1'))?.status).toBe('CLOSED');

    // Survives a reload: the server's answer, not the optimistic one.
    await page.reload();
    await expect(card.locator('[data-court-status]')).toHaveText(c.status.CLOSED);

    await card.getByRole('button', { name: c.action.reopen }).click();
    await expect(card.locator('[data-court-status]')).toHaveText(c.status.ACTIVE);
    await expect.poll(async () => (await courtRow(club.tenantId, 'Корт 1'))?.status).toBe('ACTIVE');
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

      // And with the sport list open. `scrollable-region-focusable` is off for
      // this one check only: the vendored Combobox's option list scrolls (8
      // options over its 250 px cap) and is not itself focusable, but it is
      // keyboard-operable — focus sits in the search box, the arrows move
      // through the options and cmdk scrolls the active one into view, which
      // the keyboard specs above drive. The primitive is vendored read-only;
      // the rule's finding is tracked upstream rather than patched here.
      await page.getByRole('combobox', { name: new RegExp(`^${c.field.sport},`) }).click();
      await expect(page.getByRole('option').first()).toBeVisible();
      await expectAxeClean(page, { disableRules: ['scrollable-region-focusable'] });
    });
  }
});
