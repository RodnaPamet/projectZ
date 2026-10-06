import { expect, signIn, test as base } from '../fixtures';
import { bookLater } from '../utils/booking-detail-journey';
import {
  chooseKindJourney,
  createAccount,
  destroyPlayer,
  shareAndJoin,
} from '../utils/booking-players-journey';
import type { E2EPlayer } from '../utils/create-player';
import { destroyPlayedClub, seedPlayedClub, type PlayedClub } from '../utils/seed-my-bookings';

/**
 * Players on a booking (#358) and the first-sign-in question (#360) on a
 * 393 px phone: the desktop journeys, plus no sideways drift with the invite
 * sheet open. `SHOTS` (a directory) saves the after-screenshots for the PR.
 */

const SHOTS = process.env.PLAYERZ_SHOTS_DIR;

const test = base.extend<{ club: PlayedClub; laterId: string; friend: E2EPlayer }>({
  club: async ({ player }, use) => {
    const club = await seedPlayedClub(player.userId);
    await use(club);
    await destroyPlayedClub(club, player.userId);
  },
  laterId: async ({ club, player }, use) => {
    await use(await bookLater(club, player.userId, 5));
  },
  friend: async ({}, use) => {
    const friend = await createAccount('friend', { name: 'Мария Георгиева', kind: 'PLAYER' });
    await use(friend);
    await destroyPlayer(friend.userId);
  },
});

test.describe('players on a booking — 393 px', () => {
  test('the booker shares a link, a second player joins, and both see it', async ({
    playerPage: page,
    browser,
    club,
    laterId,
    friend,
  }) => {
    await shareAndJoin(page, browser, {
      bookingId: laterId,
      venueName: club.venueName,
      friend,
      viewport: page.viewportSize() ?? { width: 393, height: 851 },
      ...(SHOTS
        ? {
            screenshot: `${SHOTS}/358-after-invite-sheet-393.png`,
            inviteScreenshot: `${SHOTS}/358-after-invite-page-393.png`,
          }
        : {}),
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    if (SHOTS) {
      await page.getByTestId('booking-invite-open').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/358-after-booking-players-393.png` });
    }
  });
});

test.describe('first sign-in — 393 px', () => {
  test('a new account chooses Играч and lands on Играй', async ({ page }) => {
    const fresh = await createAccount('fresh', { name: null, kind: null });
    try {
      await signIn(page, fresh);
      await chooseKindJourney(page, SHOTS ? `${SHOTS}/360-after-kind-chooser-393.png` : undefined);
    } finally {
      await destroyPlayer(fresh.userId);
    }
  });
});
