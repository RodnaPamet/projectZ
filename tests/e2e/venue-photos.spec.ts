import { test as base } from './fixtures';
import { destroyClubVenue, seedClubVenue, type ClubVenue } from './utils/club-page-journey';
import {
  destroyVenuePhotos,
  expectCoverOnClubPage,
  expectCoverOnVenuePage,
  uploadCover,
} from './utils/venue-photos-journey';

/**
 * Venue photos at 1280 px (#366): the owner uploads a cover, and it shows on
 * the venue page and the club page. The 393 px twin is
 * tests/e2e/mobile/venue-photos.spec.ts.
 */
const test = base.extend<{ venue: ClubVenue }>({
  venue: async ({ isolatedTenant }, use) => {
    const venue = await seedClubVenue(isolatedTenant.tenantId, `ph-${isolatedTenant.testRun}`);
    await use(venue);
    await destroyVenuePhotos(venue.venueId);
    await destroyClubVenue(venue);
  },
});

test.use({ viewport: { width: 1280, height: 900 } });

test.describe('venue photos, 1280 px', () => {
  test('upload a cover; it shows on the venue page and the club page', async ({
    authedPage: page,
    isolatedTenant,
    venue,
  }) => {
    const alt = 'Падел кортът отвън, вечер';
    await uploadCover(page, isolatedTenant.tenantSlug, venue.name, alt);
    await expectCoverOnVenuePage(page, venue.publicSlug, alt);
    await expectCoverOnClubPage(page, isolatedTenant.tenantSlug, alt);
  });
});
