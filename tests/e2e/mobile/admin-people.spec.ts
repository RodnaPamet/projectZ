import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { THEME_COOKIE } from '../../../src/lib/theme-constants';
import { expect, test as base } from '../fixtures';
import { prisma } from '../utils/create-isolated-tenant';

/**
 * Players and staff on a 393 px phone, as the club's OWNER (T25): the same
 * search, tag and suspend as the desktop spec, checked for what a phone adds —
 * the DataTable is its cards and not a table, each card's name is a 44 px
 * button that opens from the keyboard, the sheet is a bottom drawer, nothing drifts
 * sideways, and axe passes in both themes.
 */

const pl = bg.admin.players;
const st = bg.admin.staff;

interface Club {
  tenantId: string;
  slug: string;
  maria: string;
  petar: string;
}

/** Two players and one STAFF member (see the desktop spec on teardown). */
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
      return { maria: maria.id, petar: m.id, userIds: [maria.id, georgi.id, petar.id] };
    });

    await use({ tenantId, slug: tenantSlug, maria: created.maria, petar: created.petar });

    await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      await tx.playerVenueRelationship.deleteMany({ where: { tenantId } });
      await tx.tenantMembership.deleteMany({ where: { id: created.petar } });
    });
    await prisma()
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
        await tx.user.deleteMany({ where: { id: { in: created.userIds } } });
      })
      .catch(() => undefined);
  },
});

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

/**
 * The card list, waited for: the server paints the desktop table
 * (`useIsBelowMd` is false until hydration), so counting before the swap
 * races it — the trap tests/e2e/mobile/lists.spec.ts records from T21.
 */
async function cardsOf(page: Page): Promise<Locator> {
  const cards = page.locator('main [data-perf-ready] [data-testid="data-table-cards"]');
  await expect(cards).toBeVisible();
  await expect(page.locator('main table')).toHaveCount(0);
  return cards;
}

/** A card (a list item since the rows have no onRowClick), and its name button. */
const card = (cards: Locator, name: string) =>
  cards.getByRole('listitem').filter({ hasText: name });
const opener = (cards: Locator, name: string) => card(cards, name).getByRole('button', { name });

async function expectTapTarget(target: Locator) {
  const box = await target.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
}

test.describe('club admin players and staff — phone', () => {
  test('players: cards, search, then tag a player from the keyboard', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/players`);
    const cards = await cardsOf(page);
    await expect(cards.getByRole('listitem')).toHaveCount(2);
    await expect(page.locator('main select')).toHaveCount(0);

    await page.getByRole('searchbox', { name: pl.search }).fill('мария');
    await expect(cards.getByRole('listitem')).toHaveCount(1);
    const maria = opener(cards, 'Мария Иванова');
    await expectTapTarget(maria);
    await expectNoDrift(page);

    // The name is the card's button: Tab reaches it, Enter opens it.
    await maria.focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Мария Иванова' });
    await expect(sheet).toBeVisible();
    await sheet.getByLabel(pl.field.tags).fill('вип, начинаещ');
    await sheet.getByRole('button', { name: pl.action.saveTags }).click();

    await expect(sheet).toBeHidden();
    await expect(card(cards, 'Мария Иванова')).toContainText('начинаещ');
    await expect.poll(() => tagsOf(club.tenantId, club.maria)).toEqual(['вип', 'начинаещ']);
    await expectNoDrift(page);
  });

  test('staff: suspend from a card through the confirm', async ({ authedPage: page, club }) => {
    await page.goto(`/t/${club.slug}/admin/staff`);
    const cards = await cardsOf(page);
    const petar = opener(cards, 'Петър Стоянов');
    await expectTapTarget(petar);

    await petar.click();
    const sheet = page.getByRole('dialog', { name: 'Петър Стоянов' });
    await sheet.getByRole('button', { name: st.action.suspend }).click();
    const dialog = page.getByRole('dialog', {
      name: st.suspend.title.replace('{name}', 'Петър Стоянов'),
    });
    await dialog.getByRole('button', { name: st.action.suspend }).click();

    await expect(card(cards, 'Петър Стоянов')).toContainText(st.status.SUSPENDED);
    await expect.poll(() => statusOf(club.petar)).toBe('SUSPENDED');
    await expectNoDrift(page);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`axe: the players and staff cards, ${theme}`, async ({
      authedPage: page,
      club,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);

      await page.goto(`/t/${club.slug}/admin/players`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await cardsOf(page);
      await expectAxeClean(page);

      await page.goto(`/t/${club.slug}/admin/staff`);
      await cardsOf(page);
      await page.getByRole('button', { name: st.action.invite }).click();
      await expect(page.getByRole('radiogroup', { name: st.field.role })).toBeVisible();
      await expectAxeClean(page);
      await expectNoDrift(page);
    });
  }
});
