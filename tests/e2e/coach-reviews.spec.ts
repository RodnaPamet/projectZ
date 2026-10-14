import { test } from './fixtures';
import { destroyClubVenue, seedClubVenue } from './utils/club-page-journey';
import {
  approveCoach,
  clearCoachLinks,
  seedTeaching,
  signInElsewhere,
} from './utils/coach-links-journey';
import {
  aReaderReportsIt,
  completeLesson,
  moderatorPublishes,
  playerRatesTheCoach,
  theAuthorDeletesIt,
  theReviewIsOnTheCoachPage,
} from './utils/coach-reviews-journey';
import { createPlayer, destroyPlayer } from './utils/create-player';
import { seedLesson } from './utils/lesson-life-journey';

/**
 * Reviewing a coach (#551; owner decisions 24–27), in real browsers. The
 * phone's run is mobile/coach-reviews.spec.ts. `PLAYERZ_SHOTS_DIR` saves the
 * screenshots.
 */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;

test('a player rates the coach after a lesson; the review is on the coach’s page; another reader reports it; the author deletes it', async ({
  browser,
  playerPage,
  player,
  coach,
  isolatedTenant,
}) => {
  test.slow();
  const venue = await seedClubVenue(
    isolatedTenant.tenantId,
    `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  );
  const slug = await approveCoach(coach.userId, isolatedTenant.userId);
  const linkId = await seedTeaching(coach.userId, {
    tenantId: isolatedTenant.tenantId,
    venueId: venue.venueId,
  });
  const reader = await createPlayer();
  const readerPage = await signInElsewhere(browser, reader);
  const text = 'Търпелив и точен, обяснява ясно.';
  try {
    const lesson = await seedLesson({
      club: isolatedTenant,
      venue,
      coach: { userId: coach.userId, linkId },
      playerId: player.userId,
      minutesFromNow: -120,
    });
    await completeLesson(lesson.bookingId);
    await playerRatesTheCoach(
      playerPage,
      { bookingId: lesson.bookingId, text },
      { shots: SHOTS, tag: 'desktop' },
    );
    await moderatorPublishes(coach.userId);
    await theReviewIsOnTheCoachPage(
      readerPage.page,
      { slug, author: player.name, text },
      { shots: SHOTS, tag: 'desktop' },
    );
    await aReaderReportsIt(
      readerPage.page,
      { slug, coachUserId: coach.userId },
      { shots: SHOTS, tag: 'desktop' },
    );
    await theAuthorDeletesIt(playerPage, slug);
  } finally {
    await playerPage.goto('about:blank');
    await readerPage.close();
    await clearCoachLinks(coach.userId);
    await destroyClubVenue(venue);
    await destroyPlayer(reader.userId);
  }
});
