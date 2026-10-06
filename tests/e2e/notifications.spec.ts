import { test as base } from './fixtures';
import { bookThenOpenTheBell } from './utils/notifications-journey';
import {
  destroyBookableVenue,
  seedBookableVenue,
  type BookableVenue,
} from './utils/seed-bookable-venue';

/**
 * The bell at 1280 px (#367): book → "Резервацията е потвърдена" with a count
 * → open → the count clears. The 393 px twin is mobile/notifications.spec.ts.
 */
const test = base.extend<{ venue: BookableVenue }>({
  venue: async ({ player }, use) => {
    void player;
    const venue = await seedBookableVenue();
    await use(venue);
    await destroyBookableVenue(venue);
  },
});

test.describe('the bell, 1280 px', () => {
  test('book → the bell counts the confirmation → open it → the count clears', async ({
    playerPage: page,
    venue,
  }) => {
    await bookThenOpenTheBell(page, venue);
  });
});
