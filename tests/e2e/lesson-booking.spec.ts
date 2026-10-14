import { test } from './fixtures';
import { destroyClubVenue, seedClubVenue } from './utils/club-page-journey';
import {
  approveCoach,
  clearCoachLinks,
  seedTeaching,
  signInClubOwner,
  signInElsewhere,
} from './utils/coach-links-journey';
import {
  clubSeesTheLesson,
  coachSeesTheLesson,
  playerBooksALesson,
  theTimeIsGone,
} from './utils/lesson-booking-journey';

/**
 * Booking a lesson (#548; owner decisions 1 and 2), in real browsers: the
 * player's, the club owner's, the coach's, and a visitor's. The phone's run
 * is mobile/lesson-booking.spec.ts. `PLAYERZ_SHOTS_DIR` saves the screenshots.
 */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;

test('a player books a lesson; it is in their Резервации, the club’s diary and the coach’s «Уроци»', async ({
  browser,
  playerPage,
  player,
  coach,
  isolatedTenant,
}) => {
  test.slow();
  const venue = await seedClubVenue(isolatedTenant.tenantId, `l${Date.now().toString(36)}`);
  const slug = await approveCoach(coach.userId, isolatedTenant.userId);
  const linkId = await seedTeaching(
    coach.userId,
    { tenantId: isolatedTenant.tenantId, venueId: venue.venueId },
    4000,
    { allWeek: true },
  );
  const who = { slug, name: coach.name, linkId };
  const owner = await signInClubOwner(browser, isolatedTenant);
  const teacher = await signInElsewhere(browser, coach);
  const visitor = await browser.newContext();
  try {
    const seen = await playerBooksALesson(playerPage, who, venue, { shots: SHOTS, tag: 'desktop' });
    await clubSeesTheLesson(owner.page, isolatedTenant, who, seen, {
      shots: SHOTS,
      tag: 'desktop',
    });
    await coachSeesTheLesson(teacher.page, venue, player.name, seen, {
      shots: SHOTS,
      tag: 'desktop',
    });
    await theTimeIsGone(await visitor.newPage(), who, seen);
  } finally {
    // Off the pages that list the lesson before its rows are deleted: a page
    // still refreshing would read a booking whose court has just gone.
    await playerPage.goto('about:blank');
    await visitor.close();
    await teacher.close();
    await owner.close();
    await clearCoachLinks(coach.userId);
    await destroyClubVenue(venue);
  }
});
