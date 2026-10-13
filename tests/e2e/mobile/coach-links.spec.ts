import { devices } from '@playwright/test';

import { test } from '../fixtures';
import { destroyClubVenue, seedClubVenue } from '../utils/club-page-journey';
import {
  approveCoach,
  clearCoachLinks,
  clubAccepts,
  clubSeesTerms,
  coachAsks,
  coachSetsTerms,
  signInClubOwner,
} from '../utils/coach-links-journey';

/**
 * A coach and a club's venue (#546) on phones: the coach's, and the club
 * owner's. Same steps as the desktop spec.
 */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;

test('phone: a coach asks a venue, the club accepts, the coach sets a price and hours', async ({
  browser,
  coach,
  coachPage,
  isolatedTenant,
}) => {
  test.slow();
  const tag = `m${Date.now().toString(36)}`;
  const venue = await seedClubVenue(isolatedTenant.tenantId, tag);
  await approveCoach(coach.userId, isolatedTenant.userId);
  const owner = await signInClubOwner(browser, isolatedTenant, { ...devices['Pixel 5'] });
  try {
    await coachAsks(coachPage, venue, { shots: SHOTS, tag: 'phone' });
    await clubAccepts(owner.page, isolatedTenant, venue, coach.name, {
      shots: SHOTS,
      tag: 'phone',
    });
    await coachSetsTerms(coachPage, venue, { shots: SHOTS, tag: 'phone' });
    await clubSeesTerms(owner.page, { shots: SHOTS, tag: 'phone' });
  } finally {
    await owner.close();
    await clearCoachLinks(coach.userId);
    await destroyClubVenue(venue);
  }
});
