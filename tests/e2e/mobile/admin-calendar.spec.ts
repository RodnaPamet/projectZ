import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { formatInTimeZone } from 'date-fns-tz';

import bg from '../../../messages/bg.json';
import { THEME_COOKIE } from '../../../src/lib/theme-constants';
import { expect, test as base } from '../fixtures';
import { prisma } from '../utils/create-isolated-tenant';

/**
 * The club diary on a 393 px phone (Pixel 5), as the club's OWNER (T26).
 *
 * Four courts, so the grid is wider than the phone: it must scroll sideways
 * inside its own scroller while the page itself never drifts. The day links
 * are 44 px targets; the day is stepped with a paired keyboard as on the
 * desktop, and a no-show is tapped through the confirm (a bottom sheet here).
 * The desktop half is tests/e2e/admin-calendar.spec.ts.
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
 * Four courts at one venue. On Корт 1, a CONFIRMED booking that started 15
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
        ['Корт 1', 'Корт 2', 'Корт 3', 'Корт 4'].map((name) =>
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

async function expectTarget(target: Locator) {
  const box = (await target.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
}

test.describe('club admin diary — phone', () => {
  test('the grid scrolls inside itself; day links are 44 px; the day steps by keyboard', async ({
    authedPage: page,
    club,
  }) => {
    const calendar = `/t/${club.slug}/admin/calendar`;
    const tomorrow = shiftDay(todayAtClub(), 1);
    await page.goto(calendar);
    await expect(page.getByRole('region', { name: 'Корт 4' })).toBeAttached();
    await expectNoDrift(page);

    const scroller = page.locator('main [data-perf-ready]');
    const { scrollWidth, clientWidth } = await scroller.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth).toBeGreaterThan(clientWidth);

    const next = page.getByRole('link', { name: c.nav.next });
    await expectTarget(next);
    await expectTarget(page.getByRole('link', { name: c.nav.previous }));

    await next.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${calendar}?day=${tomorrow}`);
    await expect(page.getByRole('link', { name: c.nav.next })).toBeFocused();
    const today = page.getByRole('link', { name: c.nav.today });
    await expectTarget(today);
    await expectNoDrift(page);

    await today.click();
    await expect(page).toHaveURL(calendar);
    await expect(page.getByRole('link', { name: c.nav.today })).toHaveCount(0);
  });

  test('courts off the edge are announced, and a chip brings one into view (audit C07)', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/calendar`);
    const scroller = page.locator('main [data-perf-ready]');
    const court4 = page.getByRole('region', { name: 'Корт 4' });
    await expect(court4).toBeAttached();

    // 4 courts, and the right edge fades: there is more that way.
    await expect(page.getByText(c.scroll.hint.replace('{count}', '4'))).toBeVisible();
    await expect(page.locator('[data-diary-fade="end"]')).toBeAttached();
    const inView = async () => {
      const box = (await scroller.boundingBox())!;
      const card = (await court4.boundingBox())!;
      return card.x >= box.x - 1 && card.x + card.width <= box.x + box.width + 1;
    };
    expect(await inView()).toBe(false);

    const chips = page.getByRole('group', { name: c.scroll.jumpTo });
    await expectTarget(chips.getByRole('button', { name: 'Корт 4' }));
    await chips.getByRole('button', { name: 'Корт 4' }).click();
    await expect.poll(inView).toBe(true);
    // At the far end now: the end fade goes, the start one comes.
    await expect(page.locator('[data-diary-fade="end"]')).toHaveCount(0);
    await expect(page.locator('[data-diary-fade="start"]')).toBeAttached();
    // The hours stay beside the courts in view.
    const ruler = (await page.locator('[data-diary-ruler]').boundingBox())!;
    expect(ruler.x).toBeGreaterThanOrEqual((await scroller.boundingBox())!.x - 1);
    await expectNoDrift(page);
  });

  test('a date field jumps to any day (audit C08)', async ({ authedPage: page, club }) => {
    const calendar = `/t/${club.slug}/admin/calendar`;
    const target = shiftDay(todayAtClub(), 9);
    await page.goto(calendar);
    await page.getByRole('textbox', { name: c.nav.pickDay }).fill(target);
    await expect(page).toHaveURL(`${calendar}?day=${target}`);
    await expect(page.getByRole('textbox', { name: c.nav.pickDay })).toHaveValue(target);
    await expect(page.getByRole('link', { name: c.nav.today })).toBeVisible();
    await expectNoDrift(page);
  });

  test('a tapped no-show goes through the confirm; cancel returns focus to the block', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/calendar`);
    const block = noShowButton(page, club.who);
    await expect(block).toBeVisible();

    await block.click();
    const dialog = page.getByRole('dialog', { name: c.noShow.confirmTitle });
    await expect(dialog).toBeVisible();
    await expectNoDrift(page);
    const cancel = dialog.getByRole('button', { name: bg.common.cancel });
    await expectTarget(cancel);
    await cancel.click();
    await expect(dialog).toHaveCount(0);
    // The Modal's phone sheet puts focus back on its opener (#329).
    await expect(block).toBeFocused();
    expect(await bookingStatus(club.startedId)).toBe('CONFIRMED');

    await block.click();
    const confirm = dialog.getByRole('button', { name: c.noShow.confirm });
    await expectTarget(confirm);
    await confirm.click();
    await expect(block).toHaveCount(0);
    await expect.poll(() => bookingStatus(club.startedId)).toBe('NO_SHOW');
    await expect(page.locator('main h2').first()).toBeFocused();
    await expectNoDrift(page);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`axe: the diary and its confirm, ${theme}`, async ({
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
      await expectAxeClean(page);
    });
  }
});
