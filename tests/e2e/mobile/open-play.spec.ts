import { expect, test as base } from '../fixtures';
import { bookLater } from '../utils/booking-detail-journey';
import { createAccount, destroyPlayer } from '../utils/booking-players-journey';
import type { E2EPlayer } from '../utils/create-player';
import { makeVenuePublic, openAskAcceptChat } from '../utils/open-play-journey';
import { destroyPlayedClub, seedPlayedClub, type PlayedClub } from '../utils/seed-my-bookings';

/**
 * Open play (#376) on a 393 px phone: the desktop journey, plus no sideways
 * drift on the game's chat. `PLAYERZ_SHOTS_DIR` saves a screenshot per step.
 */

const SHOTS = process.env.PLAYERZ_SHOTS_DIR;

const test = base.extend<{ club: PlayedClub; laterId: string; friend: E2EPlayer }>({
  club: async ({ player }, use) => {
    const club = await seedPlayedClub(player.userId);
    await makeVenuePublic(club);
    await use(club);
    await destroyPlayedClub(club, player.userId);
  },
  laterId: async ({ club, player }, use) => {
    await use(await bookLater(club, player.userId, 5));
  },
  friend: async ({}, use) => {
    const friend = await createAccount('open-play', { name: 'Мария Георгиева', kind: 'PLAYER' });
    await use(friend);
    await destroyPlayer(friend.userId);
  },
});

test.describe('open play — 393 px', () => {
  test('a booker opens a game, a player asks, the booker accepts, and they share a chat', async ({
    playerPage: page,
    browser,
    club,
    laterId,
    friend,
  }) => {
    await openAskAcceptChat(page, browser, {
      bookingId: laterId,
      club,
      friend,
      viewport: page.viewportSize() ?? { width: 393, height: 851 },
      ...(SHOTS
        ? {
            shots: {
              opened: `${SHOTS}/376-1-booking-opened-393.png`,
              games: `${SHOTS}/376-2-games-393.png`,
              asked: `${SHOTS}/376-3-asked-393.png`,
              request: `${SHOTS}/376-4-request-393.png`,
              accepted: `${SHOTS}/376-5-accepted-393.png`,
              chat: `${SHOTS}/376-6-chat-393.png`,
            },
          }
        : {}),
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
