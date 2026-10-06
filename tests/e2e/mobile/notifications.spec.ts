import { expect, test as base } from '../fixtures';
import { bookThenOpenTheBell } from '../utils/notifications-journey';
import {
  destroyBookableVenue,
  seedBookableVenue,
  type BookableVenue,
} from '../utils/seed-bookable-venue';
import { expectNoDrift } from '../utils/venue-booking-journey';

/**
 * The bell at 393 px (Pixel 5, #367): the same journey as the 1280 px spec,
 * with the list in a bottom sheet, and nothing drifting sideways.
 */
const test = base.extend<{ venue: BookableVenue }>({
  venue: async ({ player }, use) => {
    void player;
    const venue = await seedBookableVenue();
    await use(venue);
    await destroyBookableVenue(venue);
  },
});

test.describe('the bell, 393 px', () => {
  test('book → the bell counts the confirmation → open it → the count clears', async ({
    playerPage: page,
    venue,
  }) => {
    await bookThenOpenTheBell(page, venue);
    await expectNoDrift(page);
    await expect(page.getByTestId('header-notifications')).toBeInViewport();
  });
});
