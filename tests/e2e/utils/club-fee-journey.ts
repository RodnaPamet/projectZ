import { readFile } from 'node:fs/promises';

import { expect, type Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { prisma } from './create-isolated-tenant';
import { expectAxeClean, expectNoDrift } from './club-page-journey';

/**
 * "Отчети и такса" (#372), shared by the 1280 px spec and its 393 px twin: the
 * owner opens the reports page from the admin nav, reads September's
 * statement (totals, the free-period notice, the lines), downloads the CSV,
 * and moves to this month, which is empty.
 *
 * The ledger is seeded directly: this walks the PAGE. How lines are written is
 * tests/integration/club-fees.test.ts's business.
 */
const r = bg.admin.reports;
const s = bg.billing.statement;
const nav = bg.common.nav;

/** A past month the statement is read for, whatever day the suite runs on. */
export const FEE_MONTH = '2026-09';

export interface FeeClub {
  tenantId: string;
  slug: string;
  bookingIds: string[];
}

/**
 * A venue, two courts and three played online bookings in September, with
 * their lines: one in the free period (the club's fee starts on 10 September)
 * and two at 10%.
 */
export async function seedFeeClub(tenantId: string, slug: string): Promise<FeeClub> {
  const bookingIds = await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.venueOrg.update({
      where: { id: tenantId },
      data: { feePercent: '10', feeStartsOn: new Date('2026-09-10T00:00:00Z') },
    });
    const venue = await tx.venue.create({
      data: {
        tenantId,
        slug: `${slug}-fees`,
        name: 'Обект Изток',
        addressLine: 'ул. Корт 1',
        city: 'Sofia',
        lat: 42.6977,
        lng: 23.3219,
        email: `${slug}-fees@playerz.test`,
      },
    });
    const courts = await Promise.all(
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
    const plays = [
      { start: '2026-09-05T15:00:00Z', court: 0, price: 2400, free: true },
      { start: '2026-09-15T16:00:00Z', court: 1, price: 2400, free: false },
      { start: '2026-09-22T17:00:00Z', court: 0, price: 3600, free: false },
    ];
    const ids: string[] = [];
    for (const p of plays) {
      const start = new Date(p.start);
      const court = courts[p.court]!;
      const b = await tx.booking.create({
        data: {
          tenantId,
          resourceId: court.id,
          startTs: start,
          endTs: new Date(start.getTime() + 3_600_000),
          status: 'COMPLETED',
          channel: 'ONLINE',
          totalCents: p.price,
          idempotencyKey: `e2e-fee-${slug}-${p.start}`,
        },
      });
      await tx.clubFeeLine.create({
        data: {
          tenantId,
          bookingId: b.id,
          kind: 'CHARGE',
          venueId: venue.id,
          venueName: venue.name,
          resourceId: court.id,
          courtName: court.name,
          bookingStartTs: start,
          statementMonth: FEE_MONTH,
          priceCents: p.price,
          feeBps: 1000,
          freePeriod: p.free,
          feeCents: p.free ? 0 : p.price / 10,
          currency: 'EUR',
        },
      });
      ids.push(b.id);
    }
    return ids;
  });
  return { tenantId, slug, bookingIds };
}

/**
 * The bookings and the venue. The fee lines stay: the ledger refuses DELETE by
 * design, they name no person, and nothing reads a destroyed club's lines.
 */
export async function cleanFeeClub(club: FeeClub): Promise<void> {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.booking.deleteMany({ where: { tenantId: club.tenantId } });
    await tx.venue.deleteMany({ where: { tenantId: club.tenantId } });
  });
}

/** The nav link, from the sidebar at 1280 px or from the drawer ("Още") on a phone. */
async function openFromNav(page: Page, club: FeeClub, phone: boolean) {
  await page.goto(`/t/${club.slug}/admin/calendar`);
  if (phone) {
    await page.getByRole('button', { name: nav.more }).click();
  }
  const link = page.getByRole('link', { name: nav.reports });
  await expect(link).toHaveAttribute('href', `/t/${club.slug}/admin/reports`);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/t/${club.slug}/admin/reports$`));
  await expect(page.getByRole('heading', { level: 1, name: r.title })).toBeVisible();
}

export async function readStatementAndDownload(page: Page, club: FeeClub, phone: boolean) {
  await openFromNav(page, club, phone);

  await page.goto(`/t/${club.slug}/admin/reports?month=${FEE_MONTH}`);
  await expect(page.getByRole('heading', { level: 1, name: r.title })).toBeVisible();
  await expect(page.getByRole('combobox', { name: `${r.month}, септември 2026 г.` })).toBeVisible();

  // The totals: three played, 84,00 € on them, 10%, 6,00 € due (0 + 2,40 + 3,60).
  // Visible only: under the 300 ms reveal throttle a streamed page can sit in
  // a hidden copy beside the shown one (see mobile/horizontal-drift.spec.ts).
  const totals = page.getByTestId('statement-totals').filter({ visible: true });
  await expect(totals).toContainText(s.total.played);
  await expect(totals).toContainText('3');
  await expect(totals).toContainText('84,00');
  await expect(totals).toContainText('10');
  await expect(totals).toContainText('6,00');

  // The free period ended on 10 September: part of this month.
  await expect(page.getByTestId('statement-free-period').filter({ visible: true })).toContainText(
    s.free.partTitle,
  );

  // The lines: in the table at 1280 px, as cards on a phone; both carry the courts.
  const lines = page.getByTestId('statement-lines').filter({ visible: true });
  await expect(lines).toContainText('Корт 1');
  await expect(lines).toContainText('Корт 2');
  await expect(lines).toContainText(s.freeBadge);

  await expectNoDrift(page);
  await expectAxeClean(page);

  // The CSV: UTF-8 with a BOM, ;-separated, Bulgarian headers, one row per line.
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: s.downloadCsv }).filter({ visible: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`playerz-${club.slug}-${FEE_MONTH}.csv`);
  const bytes = await readFile((await file.path())!);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const rows = bytes.subarray(3).toString('utf8').split('\r\n');
  expect(rows[0]).toBe(
    'Дата;Час;Обект;Корт;Вид;Цена (EUR);Такса %;Безплатен период;Такса (EUR);Резервация',
  );
  expect(rows.slice(1, -1)).toEqual([
    `05.09.2026;18:00;Обект Изток;Корт 1;Игра;24,00;10,00;Да;0,00;${club.bookingIds[0]}`,
    `15.09.2026;19:00;Обект Изток;Корт 2;Игра;24,00;10,00;Не;2,40;${club.bookingIds[1]}`,
    `22.09.2026;20:00;Обект Изток;Корт 1;Игра;36,00;10,00;Не;3,60;${club.bookingIds[2]}`,
  ]);
}

/** Pick this month in the picker: the URL follows, and the month is empty. */
export async function switchToThisMonth(page: Page, club: FeeClub) {
  const now = new Date();
  const thisMonth = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
  })
    .format(now)
    .slice(0, 7);
  const label = new Intl.DateTimeFormat('bg', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Sofia',
  }).format(now);

  await page.goto(`/t/${club.slug}/admin/reports?month=${FEE_MONTH}`);
  const picker = page.getByRole('combobox', { name: new RegExp(`^${r.month},`) });
  await picker.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.getByRole('option', { name: label }).click();

  await expect(page).toHaveURL(new RegExp(`/admin/reports\\?month=${thisMonth}$`));
  await expect(page.getByText(s.empty.title).filter({ visible: true })).toBeVisible();
  await expectNoDrift(page);
}
