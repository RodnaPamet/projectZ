import bg from '../../../messages/bg.json';
import { expect, test as base } from '../fixtures';
import {
  destroyBookableVenue,
  seedBookableVenue,
  type BookableVenue,
} from '../utils/seed-bookable-venue';
import { expectNoDrift, pickTomorrow } from '../utils/venue-booking-journey';
import { drawTheCourt } from '../utils/venue-plan';

/**
 * The venue plan at 393 px (Pixel 5, #625): it fits the phone, the start times
 * scroll inside themselves rather than the page, and a tap on the court is
 * the pick.
 */
const p = bg.venue.plan;
const test = base.extend<{ venue: BookableVenue }>({
  venue: async ({ player }, use) => {
    void player;
    const venue = await seedBookableVenue();
    await drawTheCourt(venue);
    await use(venue);
    await destroyBookableVenue(venue);
  },
});

test.describe('the venue plan, 393 px', () => {
  test('a tap on the court is the pick, and nothing drifts sideways', async ({
    playerPage: page,
    venue,
  }) => {
    await page.goto(`/venues/${venue.publicSlug}`);
    await pickTomorrow(page, venue);
    const plan = page.getByRole('img', { name: p.label });
    await expect(plan).toBeVisible();
    await expectNoDrift(page);

    await plan.tap();
    await expect(
      page.getByRole('group', { name: 'Часове, Корт 1' }).getByRole('button').first(),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
