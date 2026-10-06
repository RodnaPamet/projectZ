import { signIn, test as base } from './fixtures';
import { bookLater } from './utils/booking-detail-journey';
import {
  chooseKindJourney,
  createAccount,
  destroyPlayer,
  shareAndJoin,
} from './utils/booking-players-journey';
import type { E2EPlayer } from './utils/create-player';
import { destroyPlayedClub, seedPlayedClub, type PlayedClub } from './utils/seed-my-bookings';

/**
 * Players on a booking (#358) and the first-sign-in question (#360) at
 * 1280 px. The 393 px twin is mobile/booking-players.spec.ts.
 */

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

test.describe('players on a booking — desktop', () => {
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
      viewport: { width: 1280, height: 800 },
    });
  });
});

test.describe('first sign-in — desktop', () => {
  test('a new account chooses Играч and lands on Играй', async ({ page }) => {
    const fresh = await createAccount('fresh', { name: null, kind: null });
    try {
      await signIn(page, fresh);
      await chooseKindJourney(page);
    } finally {
      await destroyPlayer(fresh.userId);
    }
  });
});
