import { test as base } from './fixtures';
import { createAccount, destroyPlayer } from './utils/booking-players-journey';
import { createStaff, type E2EPlayer } from './utils/create-player';
import { browserFor } from './utils/results-journey';
import { destroyPlayedClub, seedPlayedClub, type PlayedClub } from './utils/seed-my-bookings';
import {
  confirmDrawAndSchedule,
  createAndOpen,
  destroyTournaments,
  enter,
  playTheFinal,
  reportAndConfirmTheFinal,
} from './utils/tournament-journey';

/**
 * A club tournament from creation to a result (#582), at 1280 px: the desk
 * creates and opens it, two players enter, the desk confirms them, makes the
 * draw and places the final; the finalists report and confirm its result
 * through the booking, and the tournament is over.
 */

const test = base.extend<{ club: PlayedClub; rival: E2EPlayer }>({
  club: async ({ player }, use) => {
    const club = await seedPlayedClub(player.userId);
    await use(club);
    await destroyTournaments(club.tenantId);
    await destroyPlayedClub(club, player.userId);
  },
  rival: async ({}, use) => {
    const rival = await createAccount('tournament-rival', {
      name: 'Мария Георгиева',
      kind: 'PLAYER',
    });
    await use(rival);
    await destroyPlayer(rival.userId);
  },
});

test.describe('a club tournament — desktop', () => {
  test('created, entered, drawn, played and over', async ({
    playerPage: page,
    browser,
    club,
    rival,
  }) => {
    const staff = await createStaff(club.tenantId);
    const desk = await browserFor(browser, staff);
    const other = await browserFor(browser, rival);
    try {
      const id = await createAndOpen(desk, club.slug, 'Есенна купа');
      await enter(page, id);
      await enter(other, id);
      await confirmDrawAndSchedule(desk, club.slug, id);
      await playTheFinal(id);
      await reportAndConfirmTheFinal(page, other, id);
    } finally {
      await other.context().close();
      await desk.context().close();
      await destroyPlayer(staff.userId);
    }
  });
});
