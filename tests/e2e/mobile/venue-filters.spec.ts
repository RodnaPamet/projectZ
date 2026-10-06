import bg from '../../../messages/bg.json';
import { expect, test as base } from '../fixtures';
import {
  clubPageToVenue,
  destroyClubVenue,
  expectAxeClean,
  expectNoDrift,
  filterToVenue,
  seedClubVenue,
} from '../utils/club-page-journey';
import {
  destroyBookableVenue,
  seedBookableVenue,
  type BookableVenue,
} from '../utils/seed-bookable-venue';

/**
 * /venues' filters (#357) and the club page (#356) at 393 px (Pixel 5): the
 * same journeys as 1280 px, and the page never scrolls sideways — the sports
 * scroll inside their own strip.
 */
const n = bg.common.nav;
const test = base.extend<{ venue: BookableVenue }>({
  venue: async ({}, use) => {
    const venue = await seedBookableVenue();
    await use(venue);
    await destroyBookableVenue(venue);
  },
});

test.describe('/venues filters and the club page, 393 px', () => {
  test('filter by sport and city, search, and open the venue', async ({ page, venue }) => {
    await page.goto('/venues');
    await expectNoDrift(page);
    await filterToVenue(page, venue);
    await expectNoDrift(page);
  });

  test('the filtered list is accessible and does not drift', async ({ page, venue }) => {
    await page.goto(`/venues?sport=PADEL&city=Sofia&q=${venue.venueName.split(' ').at(-1)}`);
    await expect(page.getByRole('main').getByRole('link', { name: venue.venueName })).toBeVisible();
    await expectNoDrift(page);
    await expectAxeClean(page);
  });

  test('club account: Още → Публична страница → the club page → its venue', async ({
    authedPage: page,
    isolatedTenant,
  }) => {
    const slug = isolatedTenant.tenantSlug;
    const venue = await seedClubVenue(isolatedTenant.tenantId, slug);
    try {
      await page.goto(`/t/${slug}/admin/calendar`);
      await page.getByTestId('bottom-tab-more').tap();
      const drawer = page.getByRole('dialog', { name: n.menu });
      await drawer.getByTestId('drawer-account').getByRole('link', { name: n.publicPage }).tap();
      await expect(page).toHaveURL(new RegExp(`/clubs/${slug}$`));
      await expectNoDrift(page);
      await expectAxeClean(page);
      await clubPageToVenue(page, `E2E ${slug}`, venue);
    } finally {
      await destroyClubVenue(venue);
    }
  });

  test('a club’s old address, signed out, opens its public page (A03)', async ({ page, venue }) => {
    await page.goto(`/t/${venue.clubSlug}`);
    await expect(page).toHaveURL(new RegExp(`/clubs/${venue.clubSlug}$`));
    await expect(page.getByRole('main').getByRole('link', { name: venue.venueName })).toBeVisible();
  });
});
