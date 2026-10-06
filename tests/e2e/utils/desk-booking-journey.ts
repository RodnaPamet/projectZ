import { expect, type Page } from '@playwright/test';
import { formatInTimeZone } from 'date-fns-tz';

import bg from '../../../messages/bg.json';
import { prisma } from './create-isolated-tenant';

/**
 * The desk journeys (#364), shared by the 1280 px spec and its 393 px twin so
 * both widths walk exactly the same steps: a desk booking from a free hour,
 * and a four-week series with one week taken and skipped.
 */
const d = bg.admin.calendar.desk;
const ZONE = 'Europe/Sofia';

export interface DeskClub {
  tenantId: string;
  slug: string;
  courtId: string;
  /** Tomorrow at the club: every hour of it is still ahead. */
  day: string;
}

const shiftDay = (isoDay: string, delta: number) => {
  const [y, m, dd] = isoDay.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, dd! + delta)).toISOString().slice(0, 10);
};

/** One court at the club, open 08:00–22:00 every day, hour units up to two. */
export async function seedDeskCourt(tenantId: string, slug: string): Promise<DeskClub> {
  const courtId = await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    const venue = await tx.venue.create({
      data: {
        tenantId,
        slug: `${slug}-desk`,
        name: 'Обект Рецепция',
        addressLine: 'ул. Корт 1',
        city: 'Sofia',
        lat: 42.6977,
        lng: 23.3219,
        email: `${slug}-desk@playerz.test`,
        timezone: ZONE,
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
        minBookingMinutes: 60,
        maxBookingMinutes: 120,
        slotStepMinutes: 60,
      },
    });
    await tx.resourceAvailability.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        tenantId,
        resourceId: court.id,
        dayOfWeek,
        openTime: new Date('1970-01-01T08:00:00Z'),
        closeTime: new Date('1970-01-01T22:00:00Z'),
      })),
    });
    return court.id;
  });
  const day = shiftDay(formatInTimeZone(new Date(), ZONE, 'yyyy-MM-dd'), 1);
  return { tenantId, slug, courtId, day };
}

export async function cleanDeskCourt(club: DeskClub): Promise<void> {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.booking.deleteMany({ where: { tenantId: club.tenantId } });
    await tx.bookingSeries.deleteMany({ where: { tenantId: club.tenantId } });
    await tx.venue.deleteMany({ where: { tenantId: club.tenantId } });
  });
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

const sheet = (page: Page) => page.getByRole('dialog', { name: d.create.title });

/** Name and phone, then wait for the server's quote to show. */
async function fillCustomer(page: Page, name: string, phone: string) {
  const dialog = sheet(page);
  await dialog.getByLabel(d.create.name).fill(name);
  await dialog.getByLabel(d.create.phone).fill(phone);
}

/**
 * Tap the free 10:00 hour on Корт 1, fill the customer, save, and see the desk
 * booking drawn on the diary — and written as DESK, CONFIRMED, at the quote.
 */
export async function bookFromEmptySlot(page: Page, club: DeskClub) {
  await page.goto(`/t/${club.slug}/admin/calendar?day=${club.day}`);
  const slot = page.getByRole('button', {
    name: d.newAt.replace('{court}', 'Корт 1').replace('{time}', '10:00'),
  });
  await slot.scrollIntoViewIfNeeded();
  await slot.click();

  const dialog = sheet(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(d.create.time)).toHaveValue('10:00');
  await fillCustomer(page, 'Иван Рецепция', '0888 123 456');
  await expect(dialog.getByText(/24,00\s€/)).toBeVisible();
  await expectNoDrift(page);

  const post = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/v1/t/${club.slug}/admin/desk-bookings` &&
      r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: d.create.submit, exact: true }).click();
  expect((await post).status()).toBe(201);
  await expect(dialog).toBeHidden();

  const block = page.getByRole('button', { name: /^Иван Рецепция, 10:00–11:00/ });
  await expect(block).toBeVisible();
  await expect(block).toHaveAttribute('data-booking-desk');

  const rows = await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return tx.booking.findMany({ where: { tenantId: club.tenantId } });
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    channel: 'DESK',
    status: 'CONFIRMED',
    guestName: 'Иван Рецепция',
    guestPhone: '+359888123456',
    totalCents: 2400,
  });

  // Its detail: who, the phone to ring, paid at the club.
  await block.click();
  const detail = page.getByRole('dialog', { name: 'Иван Рецепция' });
  await expect(detail.getByRole('link', { name: '+359888123456' })).toBeVisible();
  await expect(detail.getByRole('button', { name: d.detail.cancelBooking })).toBeVisible();
  await expectNoDrift(page);
}

/**
 * Two weeks from tomorrow, 12:00 is already taken. A four-week series at 12:00
 * shows that week as taken, saves the other three, and the diary marks them.
 */
export async function seriesWithOneClashSkipped(page: Page, club: DeskClub) {
  const taken = shiftDay(club.day, 14);
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    const start = new Date(`${taken}T09:00:00Z`);
    // 12:00 at the club: UTC+2 or UTC+3 depending on the season.
    const offset = formatInTimeZone(start, ZONE, 'xxx');
    const startTs = new Date(`${taken}T12:00:00${offset}`);
    await tx.booking.create({
      data: {
        tenantId: club.tenantId,
        resourceId: club.courtId,
        guestName: 'Някой друг',
        startTs,
        endTs: new Date(startTs.getTime() + 3_600_000),
        status: 'CONFIRMED',
        totalCents: 2400,
        idempotencyKey: `e2e-desk-clash-${club.slug}`,
      },
    });
  });

  await page.goto(`/t/${club.slug}/admin/calendar?day=${club.day}`);
  await page.getByRole('button', { name: d.new, exact: true }).click();
  const dialog = sheet(page);
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(d.create.time).fill('12:00');
  await fillCustomer(page, 'Мария Редовна', '+359 877 000 111');
  await dialog.getByText(d.create.repeat, { exact: true }).click();

  const weeks = dialog.locator('[data-desk-week]');
  await expect(weeks).toHaveCount(4);
  await expect(dialog.locator('[data-desk-week-status="taken"]')).toHaveCount(1);
  await expect(dialog.locator(`[data-desk-week="${taken}"]`)).toHaveAttribute(
    'data-desk-week-status',
    'taken',
  );
  await expectNoDrift(page);

  const post = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/v1/t/${club.slug}/admin/booking-series` &&
      r.request().method() === 'POST',
  );
  await dialog.locator('[data-desk-save]').click();
  const res = await post;
  expect(res.status()).toBe(201);
  expect(JSON.parse(res.request().postData()!).skipDates).toEqual([taken]);
  await expect(dialog).toBeHidden();

  const block = page.getByRole('button', { name: /^Мария Редовна, 12:00–13:00/ });
  await expect(block).toBeVisible();
  await expect(block.locator('[data-desk-series-mark]')).toHaveText(d.seriesMark);

  const series = await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return tx.bookingSeries.findFirstOrThrow({
      where: { tenantId: club.tenantId },
      include: { bookings: { orderBy: { startTs: 'asc' } } },
    });
  });
  expect(series.bookings.map((b) => formatInTimeZone(b.startTs, ZONE, 'yyyy-MM-dd HH:mm'))).toEqual(
    [`${club.day} 12:00`, `${shiftDay(club.day, 7)} 12:00`, `${shiftDay(club.day, 21)} 12:00`],
  );
}
