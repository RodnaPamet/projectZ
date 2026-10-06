import bg from '../../messages/bg.json';
import { expect, test as base } from './fixtures';
import { expectAxeClean, filterToVenue } from './utils/club-page-journey';
import {
  destroyBookableVenue,
  seedBookableVenue,
  type BookableVenue,
} from './utils/seed-bookable-venue';

/**
 * /venues' filters at 1280 px (#357): sport, city and text, each in the URL
 * without a document load, then into a venue. The 393 px twin is
 * tests/e2e/mobile/venue-filters.spec.ts.
 */
const test = base.extend<{ venue: BookableVenue }>({
  venue: async ({}, use) => {
    const venue = await seedBookableVenue();
    await use(venue);
    await destroyBookableVenue(venue);
  },
});

test.describe('/venues filters, 1280 px', () => {
  test('filter by sport and city, search, and open the venue', async ({ page, venue }) => {
    await filterToVenue(page, venue);
  });

  test('a filtered URL renders filtered, and Back undoes a filter', async ({ page, venue }) => {
    await page.goto(`/venues?sport=PADEL&city=Sofia&q=${venue.venueName.split(' ').at(-1)}`);
    await expect(page.getByRole('main').getByRole('link', { name: venue.venueName })).toBeVisible();
    await expectAxeClean(page);

    await page.getByRole('radio', { name: bg.venues.filters.allSports }).click();
    await expect(page).not.toHaveURL(/sport=/);
    await page.goBack();
    await expect(page).toHaveURL(/sport=PADEL/);
  });

  test('a sport outside the enum is ignored, not a server error (#334)', async ({ page }) => {
    const res = await page.goto('/venues?sport=foo');
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('radio', { name: bg.venues.filters.allSports })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const api = await page.request.get('/api/v1/venues?sport=foo');
    expect(api.status()).toBe(400);
  });
});
