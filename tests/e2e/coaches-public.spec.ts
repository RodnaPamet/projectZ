import bg from '../../messages/bg.json';
import { expect, test } from './fixtures';
import { destroyClubVenue, seedClubVenue } from './utils/club-page-journey';
import { approveCoach, clearCoachLinks, seedTeaching } from './utils/coach-links-journey';
import { findACoach } from './utils/coaches-public-journey';
import { streamed } from './utils/streamed';

/**
 * Finding a coach, signed out (#547; owner decision 10). The phone's run is
 * mobile/coaches-public.spec.ts. `PLAYERZ_SHOTS_DIR` saves the screenshots.
 */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;

test('a visitor finds a coach in the list, opens their page, and goes on to the venue', async ({
  page,
  coach,
  isolatedTenant,
}) => {
  const venue = await seedClubVenue(isolatedTenant.tenantId, `p${Date.now().toString(36)}`);
  const slug = await approveCoach(coach.userId, isolatedTenant.userId);
  await seedTeaching(coach.userId, { tenantId: isolatedTenant.tenantId, venueId: venue.venueId });
  try {
    await findACoach(page, { slug, name: coach.name }, venue, { shots: SHOTS, tag: 'desktop' });
  } finally {
    await clearCoachLinks(coach.userId);
    await destroyClubVenue(venue);
  }
});

test('a coach nobody can book yet is not in the list; their page says they teach nowhere', async ({
  page,
  coach,
  isolatedTenant,
}) => {
  // Approved, and no venue at all.
  const slug = await approveCoach(coach.userId, isolatedTenant.userId);
  try {
    await page.goto('/coaches');
    await streamed(page);
    await expect(page.locator(`[data-testid="coach-card"][data-coach="${slug}"]`)).toHaveCount(0);

    const res = await page.goto(`/coaches/${slug}`);
    expect(res?.status()).toBe(200);
    await streamed(page);
    await expect(page.getByTestId('coach-page-nowhere')).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  } finally {
    await clearCoachLinks(coach.userId);
  }
});

test('an address that names no approved coach is the not-found page, kept out of search', async ({
  page,
}) => {
  // The page streams (it has a loading state), so the status is already sent
  // when the coach turns out not to exist: as for a venue, what a visitor and
  // a search engine get is the not-found page and a noindex.
  await page.goto('/coaches/nobody-by-this-name');
  await expect(page.getByRole('heading', { level: 1, name: bg.notFound.title })).toBeVisible();
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute('content', /noindex/);
  await expect(page.getByTestId('coach-page')).toHaveCount(0);
});
