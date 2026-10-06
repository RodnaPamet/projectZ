import { expect, type Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import type { BookableVenue } from './seed-bookable-venue';
import {
  confirmAndSeeIt,
  expectAxeClean,
  pickFirstTime,
  pickTomorrow,
} from './venue-booking-journey';

/**
 * The bell (#367), shared by the 1280 px spec and its 393 px twin: book a
 * court, and the header's bell counts "Резервацията е потвърдена"; open it,
 * the row is there and links to the booking, and the count clears.
 */
const n = bg.common.nav;

export async function bookThenOpenTheBell(page: Page, venue: BookableVenue) {
  await page.goto(`/venues/${venue.publicSlug}`);
  const bell = page.getByTestId('header-notifications');
  await expect(bell).toHaveAccessibleName(n.notifications);
  await expect(bell.getByTestId('notifications-count')).toHaveCount(0);

  await pickTomorrow(page, venue);
  const label = await pickFirstTime(page);
  await page.getByRole('button', { name: bg.venue.book }).click();
  await confirmAndSeeIt(page, venue, label);

  // Counted at once: the booking's write refreshes the bell's read.
  await expect(bell.getByTestId('notifications-count')).toHaveText('1');
  await expect(bell).toHaveAccessibleName(n.notificationsUnread.replace('{count}', '1'));

  const marked = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/v1/me/notifications/read' &&
      r.request().method() === 'POST',
  );
  await bell.click();
  const panel = page.getByTestId('notifications-panel');
  const row = panel.getByRole('link', { name: /Резервацията е потвърдена/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText(venue.venueName);
  expect((await marked).status()).toBe(200);

  await expect(bell.getByTestId('notifications-count')).toHaveCount(0);
  await expectAxeClean(page);

  await row.click();
  await expect(page).toHaveURL(/\/me\/bookings\/[^/?]+$/);
  await expect(bell).toHaveAccessibleName(n.notifications);
}
