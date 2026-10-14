import { test as base } from './fixtures';
import { createAccount, destroyPlayer } from './utils/booking-players-journey';
import { createStaff, type E2EPlayer } from './utils/create-player';
import {
  addToCompleted,
  browserFor,
  confirmAndSeeRating,
  disputeAndDecide,
  report,
} from './utils/results-journey';
import { destroyPlayedClub, seedPlayedClub, type PlayedClub } from './utils/seed-my-bookings';

/**
 * A booking's result (#575, #582), at 1280 px: report → confirm → a rating on
 * the profile; and report → dispute → the club decides.
 */

const test = base.extend<{ club: PlayedClub; friend: E2EPlayer }>({
  club: async ({ player }, use) => {
    const club = await seedPlayedClub(player.userId);
    await use(club);
    await destroyPlayedClub(club, player.userId);
  },
  friend: async ({ club }, use) => {
    const friend = await createAccount('result-friend', {
      name: 'Мария Георгиева',
      kind: 'PLAYER',
    });
    await addToCompleted(club, friend.userId);
    await use(friend);
    await destroyPlayer(friend.userId);
  },
});

test.describe('a booking result — desktop', () => {
  test('one side reports, the other confirms, and the rating shows on the profile', async ({
    playerPage: page,
    browser,
    club,
    friend,
  }) => {
    await report(page, club.completedId);
    const other = await browserFor(browser, friend);
    try {
      await confirmAndSeeRating(page, other, club.completedId);
    } finally {
      await other.context().close();
    }
  });

  test('the other side disputes it, and the club’s desk decides', async ({
    playerPage: page,
    browser,
    club,
    friend,
  }) => {
    await report(page, club.completedId);
    const staff = await createStaff(club.tenantId);
    const other = await browserFor(browser, friend);
    const desk = await browserFor(browser, staff);
    try {
      await disputeAndDecide(other, desk, club);
    } finally {
      await other.context().close();
      await desk.context().close();
      await destroyPlayer(staff.userId);
    }
  });
});
