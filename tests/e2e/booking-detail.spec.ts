import bg from '../../messages/bg.json';
import { THEME_COOKIE } from '../../src/lib/theme-constants';
import { expect, test as base } from './fixtures';
import {
  bookLater,
  expectAxeClean,
  expectCutoffPassed,
  openAndCancel,
  streamed,
} from './utils/booking-detail-journey';
import { destroyPlayedClub, seedPlayedClub, type PlayedClub } from './utils/seed-my-bookings';

/**
 * The booking detail page at 1280 px (#359): from Предстоящи to a booking,
 * cancelled inside the venue's cutoff, and the disabled state past it. The
 * 393 px twin is mobile/booking-detail.spec.ts.
 */

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

test.describe('booking detail — desktop', () => {
  test('open a booking from the list and cancel it within the cutoff', async ({
    playerPage: page,
    club,
    laterId,
  }) => {
    await openAndCancel(page, club, laterId);
  });

  test('past the cutoff the cancel is disabled, with the club’s phone', async ({
    playerPage: page,
    club,
  }) => {
    await expectCutoffPassed(page, club);
  });

  test("somebody else's booking id is the not-found page, and shows nothing of it", async ({
    playerPage: page,
    club,
  }) => {
    // The status is 200, not 404: the page streams behind its loading.tsx, so
    // the status line has gone before the read decides. The API route is the
    // one that answers 404 (tests/integration/api-v1-me-booking-detail).
    // Role locators only: they skip hidden nodes, and a not-found render leaves
    // a hidden streamed segment behind, so `streamed()` would never settle.
    await page.goto('/me/bookings/cl0000000000000000000000000');
    await expect(page.getByRole('heading', { level: 1, name: bg.notFound.title })).toBeVisible();
    await expect(page.getByRole('main').getByText(club.venueName)).toHaveCount(0);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`axe: the detail with the cancel dialog open, ${theme}`, async ({
      playerPage: page,
      laterId,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto(`/me/bookings/${laterId}`);
      await streamed(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expectAxeClean(page);
      await page.getByTestId('booking-cancel-button').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectAxeClean(page);
    });
  }
});
