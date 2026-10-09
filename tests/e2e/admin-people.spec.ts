import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import bg from '../../messages/bg.json';
import { THEME_COOKIE } from '../../src/lib/theme-constants';
import { expect, test as base } from './fixtures';
import { prisma } from './utils/create-isolated-tenant';
import { settleAnimations } from './utils/settle-animations';

/**
 * Players and staff at 1280 px, as the club's OWNER (T25).
 *
 * Both lists are the vendored DataTable now, so at this width they are real
 * tables, and a row opens its Sheet from the keyboard through the name button.
 * A tag is saved and read back from the database; a member is suspended
 * through the confirm and stays suspended across a reload (the server's
 * answer, not the optimistic one). The invite form offers MANAGER and STAFF
 * and starts on STAFF (#278). The phone half is
 * tests/e2e/mobile/admin-people.spec.ts.
 */

const pl = bg.admin.players;
const st = bg.admin.staff;

interface Club {
  tenantId: string;
  slug: string;
  maria: string;
  petar: { userId: string; membershipId: string };
}

/**
 * Two players and one STAFF member, in the spec's own club.
 *
 * `player_venue_relationship.tenantId` is not a foreign key, so those rows do
 * not cascade from the club `isolatedTenant` deletes and go here; the
 * accounts go too. Memberships cascade from the club.
 */
const test = base.extend<{ club: Club }>({
  club: async ({ isolatedTenant }, use) => {
    const { tenantId, tenantSlug } = isolatedTenant;
    const tag = tenantSlug.slice(-8);
    const created = await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      const maria = await tx.user.create({
        data: { email: `maria-${tag}@playerz.test`, name: 'Мария Иванова', accountKind: 'PLAYER' },
      });
      const georgi = await tx.user.create({
        data: { email: `georgi-${tag}@playerz.test`, name: 'Георги Димов', accountKind: 'PLAYER' },
      });
      await tx.playerVenueRelationship.createMany({
        data: [
          { tenantId, playerUserId: maria.id, tags: ['вип'], noShowCount: 1 },
          { tenantId, playerUserId: georgi.id, tags: [] },
        ],
      });
      const petar = await tx.user.create({
        data: { email: `petar-${tag}@playerz.test`, name: 'Петър Стоянов', accountKind: 'CLUB' },
      });
      const m = await tx.tenantMembership.create({
        data: { tenantId, userId: petar.id, role: 'STAFF', status: 'ACTIVE' },
      });
      // A player who joined by booking (#229): an ACTIVE PLAYER membership and
      // a booking, and NO relationship row. The players screen must list him
      // (#348); the staff screen must not (#349).
      const ivan = await tx.user.create({
        data: { email: `ivan-${tag}@playerz.test`, name: 'Иван Резервиращ', accountKind: 'PLAYER' },
      });
      await tx.tenantMembership.create({
        data: { tenantId, userId: ivan.id, role: 'PLAYER', status: 'ACTIVE' },
      });
      const venue = await tx.venue.create({
        data: {
          tenantId,
          slug: `${tenantSlug}-people`,
          name: 'Обект',
          addressLine: '1 Court St',
          city: 'Sofia',
          lat: 42.6977,
          lng: 23.3219,
          email: `${tenantSlug}-people@playerz.test`,
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
      await tx.booking.create({
        data: {
          tenantId,
          resourceId: court.id,
          bookedByUserId: ivan.id,
          startTs: new Date(Date.now() - 26 * 3_600_000),
          endTs: new Date(Date.now() - 25 * 3_600_000),
          status: 'COMPLETED',
          totalCents: 2400,
          idempotencyKey: `e2e-people-${tenantSlug}`,
        },
      });
      return {
        maria: maria.id,
        userIds: [maria.id, georgi.id, petar.id, ivan.id],
        petar: { userId: petar.id, membershipId: m.id },
      };
    });

    await use({ tenantId, slug: tenantSlug, maria: created.maria, petar: created.petar });

    await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      await tx.playerVenueRelationship.deleteMany({ where: { tenantId } });
      await tx.booking.deleteMany({ where: { tenantId } });
      await tx.venue.deleteMany({ where: { tenantId } });
      await tx.tenantMembership.deleteMany({
        where: { tenantId, userId: { in: created.userIds } },
      });
    });
    // Best effort, as destroyPlayer: an append-only audit row naming an
    // account would refuse the delete, and one inert account is not worth
    // failing a passing spec over.
    await prisma()
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
        await tx.user.deleteMany({ where: { id: { in: created.userIds } } });
      })
      .catch(() => undefined);
  },
});

test.use({ viewport: { width: 1280, height: 900 } });

const tagsOf = (tenantId: string, playerUserId: string) =>
  prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return (
      await tx.playerVenueRelationship.findFirstOrThrow({
        where: { tenantId, playerUserId },
        select: { tags: true },
      })
    ).tags;
  });

const statusOf = (membershipId: string) =>
  prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return (
      await tx.tenantMembership.findUniqueOrThrow({
        where: { id: membershipId },
        select: { status: true },
      })
    ).status;
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

test.describe('club admin players and staff — desktop', () => {
  test('players: search, then tag a player from the keyboard', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/players`);
    const table = page.locator('main [data-perf-ready] table');
    await expect(table).toBeVisible();
    await expect(page.locator('main select')).toHaveCount(0);
    for (const header of [pl.field.name, pl.field.email, pl.field.tags, pl.field.credit]) {
      await expect(table.getByRole('columnheader', { name: header, exact: true })).toBeVisible();
    }
    // Мария and Георги from the club's notes, and Иван from his booking alone (#348).
    await expect(table.locator('tbody tr')).toHaveCount(3);
    await expect(table.getByRole('button', { name: 'Иван Резервиращ' })).toBeVisible();

    await page.getByRole('searchbox', { name: pl.search }).fill('мария');
    await expect(table.locator('tbody tr')).toHaveCount(1);

    // The name is the row's keyboard path at this width.
    await table.getByRole('button', { name: 'Мария Иванова' }).focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Мария Иванова' });
    await expect(sheet).toBeVisible();
    await sheet.getByLabel(pl.field.tags).fill('вип, начинаещ');
    await sheet.getByRole('button', { name: pl.action.saveTags }).click();

    await expect(sheet).toBeHidden();
    await expect(table.locator('tbody tr').first()).toContainText('начинаещ');
    await expect.poll(() => tagsOf(club.tenantId, club.maria)).toEqual(['вип', 'начинаещ']);
    await expectNoDrift(page);
  });

  test('staff: suspend through the confirm, and it stays suspended', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/staff`);
    const table = page.locator('main [data-perf-ready] table');
    await expect(table).toBeVisible();
    await expect(page.locator('main select')).toHaveCount(0);
    const row = table.locator('tbody tr', { hasText: 'Петър Стоянов' });
    // Staff only: the owner and Петър, and not Иван, who only booked (#349).
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(table.locator('tbody tr', { hasText: 'Иван Резервиращ' })).toHaveCount(0);

    await row.getByRole('button', { name: 'Петър Стоянов' }).click();
    const sheet = page.getByRole('dialog', { name: 'Петър Стоянов' });
    await sheet.getByRole('button', { name: st.action.suspend }).click();

    const dialog = page.getByRole('dialog', {
      name: st.suspend.title.replace('{name}', 'Петър Стоянов'),
    });
    await expect(dialog).toContainText(st.suspend.confirm);
    await dialog.getByRole('button', { name: st.action.suspend }).click();

    await expect(row).toContainText(st.status.SUSPENDED);
    await expect.poll(() => statusOf(club.petar.membershipId)).toBe('SUSPENDED');

    await page.reload();
    await expect(page.locator('main tbody tr', { hasText: 'Петър Стоянов' })).toContainText(
      st.status.SUSPENDED,
    );
    await expectNoDrift(page);
  });

  test('#278: the invite offers MANAGER and STAFF, and starts on STAFF', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/staff`);
    await page.getByRole('button', { name: st.action.invite }).click();

    const roles = page.getByRole('radiogroup', { name: st.field.role });
    await expect(roles.getByRole('radio')).toHaveCount(2);
    await expect(roles.getByRole('radio', { name: st.role.STAFF })).toBeChecked();
    await expect(roles.getByRole('radio', { name: st.role.MANAGER })).not.toBeChecked();
    await expect(roles.getByRole('radio', { name: st.role.COACH })).toHaveCount(0);
  });

  test('#328: invite, then invite again without a reload; the invite is listed either way', async ({
    authedPage: page,
    club,
  }) => {
    // Through the real form and the Radix radio group's bubble input. Whether
    // the mail goes out depends on the run's SMTP, so both answers are
    // covered: a sent invite closes the form, a MAIL_FAILED keeps it open with
    // the error, and either way the invite is in the list with its withdraw
    // button (audit C11), without a reload.
    await page.goto(`/t/${club.slug}/admin/staff`);
    const pending = (email: string) => page.locator('[data-invite-id]', { hasText: email });
    const emailField = page.getByLabel(st.field.email);

    async function invite(email: string) {
      await page.getByRole('button', { name: st.action.invite }).click();
      await expect(emailField).toBeVisible();
      // Still open a moment later: the first success used to close every
      // later opening on its next render.
      await page.waitForTimeout(300);
      await expect(emailField).toBeVisible();
      await emailField.fill(email);
      await page
        .getByRole('radiogroup', { name: st.field.role })
        .getByRole('radio', { name: st.role.STAFF })
        .click();
      await page.getByRole('button', { name: st.action.send }).click();
      await expect(pending(email)).toBeVisible();
      await expect(pending(email).getByRole('button', { name: st.action.revoke })).toBeVisible();
      const failed = page.getByText(st.error.MAIL_FAILED);
      if (await failed.isVisible()) {
        await page.getByRole('button', { name: st.action.cancel }).click();
      }
      await expect(emailField).toHaveCount(0);
    }

    const tag = club.slug.slice(-8);
    await invite(`first-${tag}@playerz.test`);
    await invite(`second-${tag}@playerz.test`);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`axe: players with a sheet open, and staff with the invite form, ${theme}`, async ({
      authedPage: page,
      club,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);

      await page.goto(`/t/${club.slug}/admin/players`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('main table')).toBeVisible();
      await expectAxeClean(page);
      await page.getByRole('button', { name: 'Георги Димов' }).click();
      await expect(page.getByRole('dialog', { name: 'Георги Димов' })).toBeVisible();
      await settleAnimations(page.getByRole('dialog', { name: 'Георги Димов' }));
      await expectAxeClean(page);

      await page.goto(`/t/${club.slug}/admin/staff`);
      await expect(page.locator('main table')).toBeVisible();
      await page.getByRole('button', { name: st.action.invite }).click();
      await expect(page.getByRole('radiogroup', { name: st.field.role })).toBeVisible();
      await expectAxeClean(page);
    });
  }
});
