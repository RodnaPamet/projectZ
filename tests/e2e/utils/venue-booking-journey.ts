import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { prisma } from './create-isolated-tenant';
import type { BookableVenue } from './seed-bookable-venue';

/**
 * The venue page journeys (#355), shared by the 1280 px spec and its 393 px
 * twin so both widths walk exactly the same steps.
 */
const v = bg.venue;

/** Tomorrow at the club, read from the day picker; wait for its slots. */
export async function pickTomorrow(page: Page, venue: BookableVenue) {
  const read = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/v1/venues/${venue.venueId}/availability` &&
      r.request().method() === 'GET' &&
      r.ok(),
  );
  await page.getByRole('radio', { name: v.day.tomorrow }).click();
  await read;
}

/** The first free time on Корт 1; returns its label ("09:00 · 24 €"). */
export async function pickFirstTime(page: Page): Promise<string> {
  const times = page.getByRole('group', { name: 'Часове, Корт 1' });
  const first = times.getByRole('button').first();
  await expect(first).toBeVisible();
  const label = (await first.textContent())!;
  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  return label;
}

/** Confirm in the sheet, and land on Резервации with the booking on it. */
export async function confirmAndSeeIt(page: Page, venue: BookableVenue, timeLabel: string) {
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(v.sheet.payAtClub)).toBeVisible();
  await expect(dialog.getByText('Корт 1')).toBeVisible();

  const post = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/v1/t/${venue.clubSlug}/bookings` &&
      r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: v.sheet.confirm }).click();
  const res = await post;
  expect(res.status()).toBe(201);
  expect(res.request().headers()['idempotency-key']).toBeTruthy();

  await expect(page).toHaveURL(/\/me\/bookings$/);
  const main = page.getByRole('main');
  await expect(main.getByText(venue.venueName).first()).toBeVisible();
  // The card shows the time the player picked (it writes 8:00, not 08:00).
  const hm = timeLabel.slice(0, 5).replace(/^0/, '');
  await expect(main.getByText(new RegExp(`(^|\\D)${hm}\\b`)).first()).toBeVisible();

  const count = await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return tx.booking.count({ where: { tenantId: venue.tenantId, status: 'CONFIRMED' } });
  });
  expect(count).toBe(1);
}

export async function expectNoDrift(page: Page) {
  const overflow = await page.evaluate(() =>
    Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth,
    ),
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

export async function expectAxeClean(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(
    (x) => x.impact === 'critical' || x.impact === 'serious',
  );
  const report = blocking
    .map((x) => `  [${x.impact}] ${x.id}: ${x.help}\n    ${x.nodes[0]?.target.join(' ')}`)
    .join('\n');
  expect(blocking, `axe found ${blocking.length} blocking violation(s):\n${report}`).toEqual([]);
}
