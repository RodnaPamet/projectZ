import { expect, test } from './fixtures';
import { destroyClubVenue, seedClubVenue } from './utils/club-page-journey';
import {
  approveCoach,
  clearCoachLinks,
  clubAccepts,
  clubSeesTerms,
  coachAsks,
  coachSetsTerms,
  signInClubOwner,
} from './utils/coach-links-journey';
import { streamed } from './utils/streamed';

/**
 * A coach and a club's venue (#546; owner decisions 2, 4, 5, 14), in real
 * browsers: the coach's and the club owner's. The phone's run is
 * mobile/coach-links.spec.ts. `PLAYERZ_SHOTS_DIR` saves the screenshots.
 */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;

test('an approved coach asks a venue, the club accepts, the coach sets a price and hours', async ({
  browser,
  coach,
  coachPage,
  isolatedTenant,
}) => {
  test.slow();
  const tag = `d${Date.now().toString(36)}`;
  const venue = await seedClubVenue(isolatedTenant.tenantId, tag);
  await approveCoach(coach.userId, isolatedTenant.userId);
  const owner = await signInClubOwner(browser, isolatedTenant);
  try {
    await coachAsks(coachPage, venue, { shots: SHOTS, tag: 'desktop' });
    await clubAccepts(owner.page, isolatedTenant, venue, coach.name, {
      shots: SHOTS,
      tag: 'desktop',
    });
    await coachSetsTerms(coachPage, venue, { shots: SHOTS, tag: 'desktop' });
    await clubSeesTerms(owner.page, { shots: SHOTS, tag: 'desktop' });
    // Ended by the club: the coach sees it, and may ask again.
    await coachPage.reload();
    await streamed(coachPage);
    await expect(coachPage.getByTestId('coach-venue')).toHaveAttribute('data-status', 'ENDED');
    await expect(coachPage.getByTestId('coach-venue-again')).toBeVisible();
  } finally {
    await owner.close();
    await clearCoachLinks(coach.userId);
    await destroyClubVenue(venue);
  }
});

test('the club’s coaches page is the owner’s: a player and a coach get a 404', async ({
  coachPage,
  isolatedTenant,
}) => {
  const res = await coachPage.goto(`/t/${isolatedTenant.tenantSlug}/admin/coaches`);
  expect(res?.status()).toBe(404);
});
