import type { Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { THEME_COOKIE } from '../../../src/lib/theme-constants';
import { expect, test as base } from '../fixtures';
import {
  bookLater,
  expectAxeClean,
  expectCutoffPassed,
  openAndCancel,
  streamed,
} from '../utils/booking-detail-journey';
import { destroyPlayedClub, seedPlayedClub, type PlayedClub } from '../utils/seed-my-bookings';

/**
 * The booking detail page on a 393 px phone (#359): the desktop journey, plus
 * what a phone adds: 44 px targets for the back link, directions and cancel,
 * and no sideways drift with an address and a dialog on screen.
 */

const mb = bg.myBookings;

const test = base.extend<{ club: PlayedClub; laterId: string }>({
  club: async ({ player }, use) => {
    const club = await seedPlayedClub(player.userId);
    await use(club);
    await destroyPlayedClub(club, player.userId);
  },
  laterId: async ({ club, player }, use) => {
    await use(await bookLater(club, player.userId, 5));
  },
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

test.describe('booking detail — phone', () => {
  test('the page under the thumb: targets, no drift', async ({ playerPage: page, laterId }) => {
    await page.goto(`/me/bookings/${laterId}`);
    await streamed(page);
    for (const target of [
      page.getByRole('main').getByRole('link', { name: mb.detail.back, exact: true }),
      page.getByTestId('booking-directions'),
      page.getByRole('button', { name: mb.detail.cancel }),
    ]) {
      const box = (await target.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await expectNoDrift(page);
  });

  test('open a booking from the list and cancel it within the cutoff', async ({
    playerPage: page,
    club,
    laterId,
  }) => {
    await openAndCancel(page, club, laterId);
    await expectNoDrift(page);
  });

  test('past the cutoff the cancel is disabled, with the club’s phone', async ({
    playerPage: page,
    club,
  }) => {
    await expectCutoffPassed(page, club);
    await expectNoDrift(page);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`axe: the detail, ${theme}`, async ({ playerPage: page, laterId, baseURL }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto(`/me/bookings/${laterId}`);
      await streamed(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expectAxeClean(page);
    });
  }
});
