import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { prisma } from './create-isolated-tenant';
import type { PlayedClub } from './seed-my-bookings';

/**
 * The booking detail journey (#359), shared by the 1280 px spec and its
 * 393 px twin: Предстоящи → a card → the detail → Отмени → Отменена, and
 * the list showing it under Минали afterwards.
 */

const mb = bg.myBookings;
const DAY = 86_400_000;

/** A CONFIRMED booking `days` from now at 16:00 UTC: well inside a 24 h cutoff's window. */
export async function bookLater(club: PlayedClub, userId: string, days: number): Promise<string> {
  const start = new Date(Date.now() + days * DAY);
  start.setUTCHours(16, 0, 0, 0);
  return prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    const b = await tx.booking.create({
      data: {
        tenantId: club.tenantId,
        resourceId: club.resourceId,
        startTs: start,
        endTs: new Date(start.getTime() + 3_600_000),
        bookedByUserId: userId,
        status: 'CONFIRMED',
        totalCents: 3000,
        idempotencyKey: `e2e-detail-${Math.random()}`,
      },
    });
    return b.id;
  });
}

/** The venue's cutoff, and a phone to call once it has passed. */
export async function setVenue(club: PlayedClub, data: { cutoffHours: number; phone?: string }) {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.venue.update({
      where: { id: club.venueId },
      data: { cancellationCutoffHours: data.cutoffHours, phone: data.phone ?? null },
    });
  });
}

/**
 * Wait until the page's streamed content is in place.
 *
 * These pages have a `loading.tsx`, so the server sends the skeleton first and
 * the page later, as `<div hidden id="S:n">…</div>` plus a script that swaps
 * it in, which React 19 holds back for up to its 300 ms reveal throttle. Until
 * then the page's markup is in the DOM TWICE in effect: hidden, and about to
 * be shown. `getByTestId` and `getByText` match hidden nodes, so a check made
 * in that window fails strict mode on two elements. Role locators skip hidden
 * nodes; these do not, so every check of them waits for this first.
 */
export async function streamed(page: Page) {
  await expect(page.locator('div[hidden][id^="S:"]')).toHaveCount(0);
}

export async function expectAxeClean(page: Page) {
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
 * From the list to a cancelled booking. Returns once the list shows it under
 * Минали, labelled Отменена.
 */
export async function openAndCancel(page: Page, club: PlayedClub, laterId: string) {
  await page.goto('/me/bookings');
  await streamed(page);
  const cards = page.locator('[data-perf-ready] > li');
  // Soonest first: tomorrow's, then the one five days out.
  await expect(cards).toHaveCount(2);

  await cards.nth(1).getByTestId('booking-card-link').click();
  await expect(page).toHaveURL(new RegExp(`/me/bookings/${laterId}$`));
  await expect(page.getByRole('heading', { level: 1, name: club.venueName })).toBeVisible();
  await expect(page.getByText(mb.detail.payAtClub)).toBeVisible();
  await expect(page.getByTestId('booking-status')).toHaveText(mb.status.CONFIRMED);
  await expect(page.getByTestId('booking-directions')).toHaveAttribute(
    'href',
    /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/,
  );
  await expect(page.getByTestId('booking-players')).toContainText(mb.detail.you);

  const cancel = page.getByRole('button', { name: mb.detail.cancel });
  await expect(cancel).toBeEnabled();
  await cancel.click();
  const dialog = page.getByRole('dialog', { name: mb.detail.confirm.title });
  await expect(dialog).toBeVisible();

  const posted = page.waitForResponse((r) =>
    r.url().endsWith(`/api/v1/t/${club.slug}/bookings/${laterId}/cancel`),
  );
  await dialog.getByRole('button', { name: mb.detail.confirm.yes }).click();
  await expect(page.getByTestId('booking-status')).toHaveText(mb.status.CANCELLED);
  expect((await posted).status()).toBe(200);
  await expect(cancel).toHaveCount(0);

  // Back to the list: gone from Предстоящи, under Минали as Отменена.
  // `exact`: the header's "Моите резервации" and the tab bar's "Резервации"
  // link to the same list; this is the page's own back link.
  await page.getByRole('main').getByRole('link', { name: mb.detail.back, exact: true }).click();
  await expect(page).toHaveURL(/\/me\/bookings$/);
  await expect(cards).toHaveCount(1);
  await page.getByRole('radio', { name: mb.tabs.past }).click();
  const cancelledCard = cards.filter({ hasText: mb.status.CANCELLED });
  await expect(cancelledCard).toHaveCount(1);
}

/** Past the cutoff: the button is there, disabled, with the reason and the phone. */
export async function expectCutoffPassed(page: Page, club: PlayedClub) {
  await setVenue(club, { cutoffHours: 168, phone: '+359 2 123 4567' });
  await page.goto(`/me/bookings/${club.confirmedId}`);
  await streamed(page);
  await expect(page.getByRole('button', { name: mb.detail.cancel })).toBeDisabled();
  const notice = page.getByTestId('booking-cutoff-passed');
  await expect(notice).toBeVisible();
  await expect(notice.getByRole('link')).toHaveAttribute('href', 'tel:+35921234567');
}
