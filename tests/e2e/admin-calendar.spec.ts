import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { formatInTimeZone } from 'date-fns-tz';

import bg from '../../messages/bg.json';
import { THEME_COOKIE } from '../../src/lib/theme-constants';
import { expect, test as base } from './fixtures';
import { prisma } from './utils/create-isolated-tenant';
import { settleAnimations } from './utils/settle-animations';

/**
 * The club diary at 1280 px, as the club's OWNER (T26).
 *
 * The day is stepped with the keyboard alone, and focus is followed through
 * it: a `?day=` change remounts the grid, so the link that was pressed is a
 * new element and focus has to be put back on purpose. A no-show goes
 * through the confirm and is read back from the database; a refused one
 * leaves its block on the grid and focus on it. The phone half is
 * tests/e2e/mobile/admin-calendar.spec.ts.
 */

const c = bg.admin.calendar;
const ZONE = 'Europe/Sofia'; // VenueOrg.timezone's default; the fixture's club keeps it.

interface Club {
  tenantId: string;
  slug: string;
  who: string;
  startedId: string;
}

/**
 * Two courts at one venue. On Корт 1, a CONFIRMED booking that started 15
 * minutes ago (so it can be marked a no-show); on Корт 2, a PENDING one that
 * started 5 minutes ago. Both overlap the club's today whatever the hour: the
 * diary shows a booking on every day it touches.
 */
const test = base.extend<{ club: Club }>({
  club: async ({ isolatedTenant }, use) => {
    const { tenantId, tenantSlug, userId } = isolatedTenant;
    const { startedId, who } = await prisma().$transaction(async (tx) => {
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
      const [one, two] = await Promise.all(
        ['Корт 1', 'Корт 2'].map((name) =>
          tx.resource.create({
            data: {
              tenantId,
              venueId: venue.id,
              name,
              sport: 'PADEL',
              surface: 'ARTIFICIAL_GRASS',
              basePriceCents: 2400,
            },
          }),
        ),
      );
      const now = Date.now();
      const started = await tx.booking.create({
        data: {
          tenantId,
          resourceId: one!.id,
          bookedByUserId: userId,
          startTs: new Date(now - 15 * 60_000),
          endTs: new Date(now + 45 * 60_000),
          status: 'CONFIRMED',
          totalCents: 2400,
          idempotencyKey: `e2e-diary-${tenantSlug}-1`,
        },
      });
      await tx.booking.create({
        data: {
          tenantId,
          resourceId: two!.id,
          guestName: 'Гост Е2Е',
          startTs: new Date(now - 5 * 60_000),
          endTs: new Date(now + 55 * 60_000),
          status: 'PENDING',
          expiresAt: new Date(now + 10 * 60_000),
          totalCents: 2400,
          idempotencyKey: `e2e-diary-${tenantSlug}-2`,
        },
      });
      // The diary names a member by their account name.
      const owner = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { name: true },
      });
      return { startedId: started.id, who: owner.name! };
    });

    await use({ tenantId, slug: tenantSlug, who, startedId });

    await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      await tx.booking.deleteMany({ where: { tenantId } });
      await tx.venue.deleteMany({ where: { tenantId } });
    });
  },
});

test.use({ viewport: { width: 1280, height: 900 } });

const shiftDay = (isoDay: string, delta: number) => {
  const [y, m, d] = isoDay.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + delta)).toISOString().slice(0, 10);
};
const todayAtClub = () => formatInTimeZone(new Date(), ZONE, 'yyyy-MM-dd');

const bookingStatus = (id: string) =>
  prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return (await tx.booking.findUnique({ where: { id }, select: { status: true } }))?.status;
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

const noShowButton = (page: Page, who: string) =>
  page.getByRole('button', { name: new RegExp(`^${who}, `) });

test.describe('club admin diary — desktop', () => {
  test('steps the day with the keyboard, and focus stays on the day links', async ({
    authedPage: page,
    club,
  }) => {
    const calendar = `/t/${club.slug}/admin/calendar`;
    const today = todayAtClub();
    const tomorrow = shiftDay(today, 1);
    await page.goto(calendar);
    const heading = page.locator('main h2').first();
    const todaysLabel = await heading.textContent();
    // The day is worded in Bulgarian, not date-fns's English.
    expect(todaysLabel).toMatch(/г\.$/);

    // No "today" link on today; Корт 1's booking is on the grid.
    await expect(page.getByRole('link', { name: c.nav.today })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Корт 1' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Корт 2' })).toBeVisible();

    await page.getByRole('link', { name: c.nav.next }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${calendar}?day=${tomorrow}`);
    await expect(heading).not.toHaveText(todaysLabel!);
    // The grid remounted; focus is back on "next", which now points a day on.
    const next = page.getByRole('link', { name: c.nav.next });
    await expect(next).toHaveAttribute('href', `${calendar}?day=${shiftDay(tomorrow, 1)}`);
    await expect(next).toBeFocused();

    // Tab reaches "today" next, and Enter goes back to the club's today.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: c.nav.today })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(calendar);
    await expect(heading).toHaveText(todaysLabel!);
    // No "today" link on today, so the day's heading takes focus.
    await expect(heading).toBeFocused();

    // Back one day from today, by keyboard too.
    await page.getByRole('link', { name: c.nav.previous }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${calendar}?day=${shiftDay(today, -1)}`);
    await expect(page.getByRole('link', { name: c.nav.previous })).toBeFocused();
    await expectNoDrift(page);
  });

  test('marks a no-show through the confirm: cancel returns focus, confirm records it', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/calendar`);
    const block = noShowButton(page, club.who);
    await expect(block).toBeVisible();

    // Keyboard: open, then cancel. Focus goes back to the block.
    await block.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: c.noShow.confirmTitle });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(club.who);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(block).toBeFocused();
    expect(await bookingStatus(club.startedId)).toBe('CONFIRMED');

    // And confirm. The block leaves the grid, and focus lands on the day.
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: c.noShow.confirm }).click();
    await expect(block).toHaveCount(0);
    await expect.poll(() => bookingStatus(club.startedId)).toBe('NO_SHOW');
    await expect(page.locator('main h2').first()).toBeFocused();
    // The pending booking is still drawn, as a block and not a control.
    await expect(page.locator('[data-booking-status="PENDING"]')).toContainText('Гост Е2Е');
    await expectNoDrift(page);
  });

  test('a refused no-show is an InlineNotice, and focus returns to the block', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/calendar`);
    const block = noShowButton(page, club.who);
    await expect(block).toBeVisible();

    // Someone else got there first: the page still offers it.
    await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      await tx.booking.update({ where: { id: club.startedId }, data: { status: 'NO_SHOW' } });
    });

    await block.click();
    const dialog = page.getByRole('dialog', { name: c.noShow.confirmTitle });
    await dialog.getByRole('button', { name: c.noShow.confirm }).click();
    await expect(dialog).toHaveCount(0);

    const alert = page.getByRole('alert').filter({ hasText: c.noShow.error.ALREADY_NO_SHOW });
    await expect(alert).toBeVisible();
    await expect(block).toBeFocused();
    await alert.getByRole('button', { name: bg.common.ui.dismiss }).click();
    await expect(alert).toHaveCount(0);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`axe: the diary, its confirm, and another day, ${theme}`, async ({
      authedPage: page,
      club,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto(`/t/${club.slug}/admin/calendar`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(noShowButton(page, club.who)).toBeVisible();
      await expectAxeClean(page);

      await noShowButton(page, club.who).click();
      await expect(page.getByRole('dialog', { name: c.noShow.confirmTitle })).toBeVisible();
      await settleAnimations(page.getByRole('dialog', { name: c.noShow.confirmTitle }));
      await expectAxeClean(page);
      await page.keyboard.press('Escape');

      // Off today: the "today" link is drawn too.
      await page.getByRole('link', { name: c.nav.next }).click();
      await expect(page.getByRole('link', { name: c.nav.today })).toBeVisible();
      await expectAxeClean(page);
      await expectNoDrift(page);
    });
  }
});
