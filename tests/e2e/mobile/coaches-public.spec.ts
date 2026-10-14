import { test } from '../fixtures';
import { destroyClubVenue, seedClubVenue } from '../utils/club-page-journey';
import { approveCoach, clearCoachLinks, seedTeaching } from '../utils/coach-links-journey';
import { findACoach } from '../utils/coaches-public-journey';

/** Finding a coach, signed out, on a phone (#547). Same steps as the desktop spec. */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;

test('phone: a visitor finds a coach, opens their page, and goes on to the venue', async ({
  page,
  coach,
  isolatedTenant,
}) => {
  const venue = await seedClubVenue(isolatedTenant.tenantId, `q${Date.now().toString(36)}`);
  const slug = await approveCoach(coach.userId, isolatedTenant.userId);
  await seedTeaching(coach.userId, { tenantId: isolatedTenant.tenantId, venueId: venue.venueId });
  try {
    await findACoach(page, { slug, name: coach.name }, venue, { shots: SHOTS, tag: 'phone' });
  } finally {
    await clearCoachLinks(coach.userId);
    await destroyClubVenue(venue);
  }
});
