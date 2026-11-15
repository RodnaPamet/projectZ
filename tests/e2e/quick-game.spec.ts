import bg from '../../messages/bg.json';
import { expect, test as base } from './fixtures';
import {
  destroyBookableVenue,
  seedBookableVenue,
  type BookableVenue,
} from './utils/seed-bookable-venue';
import { streamed } from './utils/streamed';

/**
 * «Създай игра» in one flow (#697), at 1280 px, the neighbour of
 * open-play.spec.ts: from Игри, a sport, the club, an hour a game can still
 * open on, the players wanted, and one button books the court and opens its
 * game; the person lands on the booking with the game looking for players.
 * Every write goes through the browser, under the context's own client address
 * (fixtures.ts, testClientIp). `PLAYERZ_SHOTS_DIR` saves a screenshot per step.
 */

const SHOTS = process.env.PLAYERZ_SHOTS_DIR;
const g = bg.games;

const test = base.extend<{ venue: BookableVenue }>({
  venue: async ({ player }, use) => {
    void player;
    const venue = await seedBookableVenue();
    await use(venue);
    await destroyBookableVenue(venue);
  },
});

test.describe('quick game — desktop', () => {
  test('Игри → «Създай игра» → sport, club, hour, players → the game is open', async ({
    playerPage: page,
    venue,
  }) => {
    await page.goto('/games');
    await streamed(page);
    await page.getByTestId('games-create').click();
    await expect(page).toHaveURL(/\/games\/new$/);
    await expect(page.getByRole('heading', { level: 1, name: g.new.title })).toBeVisible();

    const main = page.getByRole('main');
    await main.getByRole('radio', { name: bg.sports.PADEL }).click();
    await main.getByTestId('new-game-club-search').fill(venue.venueName);
    const clubs = main.getByTestId('new-game-clubs');
    await clubs.locator(`[data-id="${venue.venueId}"]`).click();

    // The club's 24-hour cutoff: the flow moves to the first day a game can
    // still open on, and offers only those hours.
    const hours = main.getByTestId('new-game-hours');
    const first = hours.locator('button[aria-pressed]').first();
    await expect(first).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/697-1-hour-1280.png`, fullPage: true });
    await first.click();

    const players = main.getByTestId('new-game-players');
    await players.getByRole('radio', { name: '2', exact: true }).click();
    await main.getByTestId('new-game-note').fill('Търсим двама за двойки.');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/697-2-players-1280.png`, fullPage: true });
    await main.getByTestId('new-game-create').click();

    await expect(page).toHaveURL(/\/me\/bookings\/[^/?]+$/);
    await streamed(page);
    await expect(main.getByTestId('booking-game-state')).toBeVisible();
    await expect(main.getByTestId('booking-game')).toContainText('Търсим двама за двойки.');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/697-3-game-1280.png`, fullPage: true });
  });
});
