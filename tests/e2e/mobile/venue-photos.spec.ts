import { test as base } from '../fixtures';
import { destroyClubVenue, seedClubVenue, type ClubVenue } from '../utils/club-page-journey';
import {
  destroyVenuePhotos,
  expectCoverOnClubPage,
  expectCoverOnVenuePage,
  uploadCover,
} from '../utils/venue-photos-journey';

/**
 * Venue photos on a 393 px phone (#366): the same journey as the desktop
 * spec, tests/e2e/venue-photos.spec.ts, where a phone is what a club owner
 * most likely uploads from. No sideways drift on any of the three pages.
 */
const test = base.extend<{ venue: ClubVenue }>({
  venue: async ({ isolatedTenant }, use) => {
    const venue = await seedClubVenue(isolatedTenant.tenantId, `phm-${isolatedTenant.testRun}`);
    await use(venue);
    await destroyVenuePhotos(venue.venueId);
    await destroyClubVenue(venue);
  },
});

test.describe('venue photos, 393 px', () => {
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
