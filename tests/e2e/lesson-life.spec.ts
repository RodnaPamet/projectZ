import { test } from './fixtures';
import { destroyClubVenue, seedClubVenue } from './utils/club-page-journey';
import {
  approveCoach,
  clearCoachLinks,
  seedTeaching,
  signInClubOwner,
  signInElsewhere,
} from './utils/coach-links-journey';
import { createPlayer, destroyPlayer } from './utils/create-player';
import { playerBooksALesson } from './utils/lesson-booking-journey';
import {
  aFriendJoinsTheLesson,
  coachMarksANoShow,
  coachSeesWhoAndCancels,
  deskCancelsTheLesson,
  playerSeesTheCoachCancelled,
  seedLesson,
  setPadelLevel,
} from './utils/lesson-life-journey';

/**
 * Living with a lesson (#549; owner decisions 8, 9, 11, 12, 18–20), in real
 * browsers. The phone's run is mobile/lesson-life.spec.ts.
 * `PLAYERZ_SHOTS_DIR` saves the screenshots.
 */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;

test('a friend joins a lesson by invitation and it becomes a group lesson; the coach sees who is coming, then cancels, and the player is told', async ({
  browser,
  playerPage,
  player,
  coach,
  isolatedTenant,
}) => {
  test.slow();
  const venue = await seedClubVenue(isolatedTenant.tenantId, `g${Date.now().toString(36)}`);
  const slug = await approveCoach(coach.userId, isolatedTenant.userId);
  const linkId = await seedTeaching(
    coach.userId,
    { tenantId: isolatedTenant.tenantId, venueId: venue.venueId },
    4000,
    { allWeek: true },
  );
  const who = { slug, name: coach.name, linkId };
  const friend = await createPlayer();
  await setPadelLevel(player.userId, 4);
  const teacher = await signInElsewhere(browser, coach);
  const visitor = await browser.newContext();
  try {
    const seen = await playerBooksALesson(playerPage, who, venue, { tag: 'life-desktop' });
    await aFriendJoinsTheLesson(
      playerPage,
      browser,
      { bookingId: seen.bookingId, coach: who, friend },
      { shots: SHOTS, tag: 'desktop' },
    );
    await coachSeesWhoAndCancels(
      teacher.page,
      { bookingId: seen.bookingId, playerName: player.name, level: 4, players: 2, fee: '60,00' },
      { shots: SHOTS, tag: 'desktop' },
    );
    await playerSeesTheCoachCancelled(playerPage, seen.bookingId);
    // The coach's time and the court are free again: 08:00 is back on offer.
    const again = await visitor.newPage();
    await again.goto(`/coaches/${slug}?at=${linkId}&day=${seen.day}`);
    await again
      .getByTestId('lesson-booking')
      .getByRole('button', { name: /^08:00/ })
      .waitFor();
  } finally {
    await playerPage.goto('about:blank');
    await visitor.close();
    await teacher.close();
    await clearCoachLinks(coach.userId);
    await destroyClubVenue(venue);
    await destroyPlayer(friend.userId);
  }
});

test('a lesson under way: the coach records that the player did not come', async ({
  coachPage,
  coach,
  player,
  isolatedTenant,
}) => {
  const venue = await seedClubVenue(isolatedTenant.tenantId, `n${Date.now().toString(36)}`);
  await approveCoach(coach.userId, isolatedTenant.userId);
  const linkId = await seedTeaching(coach.userId, {
    tenantId: isolatedTenant.tenantId,
    venueId: venue.venueId,
  });
  try {
    const lesson = await seedLesson({
      club: isolatedTenant,
      venue,
      coach: { userId: coach.userId, linkId },
      playerId: player.userId,
      minutesFromNow: -15,
    });
    await coachMarksANoShow(
      coachPage,
      {
        bookingId: lesson.bookingId,
        playerName: player.name,
        clubName: `E2E ${isolatedTenant.tenantSlug}`,
      },
      { shots: SHOTS, tag: 'desktop' },
    );
  } finally {
    await clearCoachLinks(coach.userId);
    await destroyClubVenue(venue);
  }
});

test('the club’s desk opens a lesson in the diary, sees who teaches it, and cancels it', async ({
  browser,
  coach,
  player,
  isolatedTenant,
}) => {
  const venue = await seedClubVenue(isolatedTenant.tenantId, `k${Date.now().toString(36)}`);
  await approveCoach(coach.userId, isolatedTenant.userId);
  const linkId = await seedTeaching(coach.userId, {
    tenantId: isolatedTenant.tenantId,
    venueId: venue.venueId,
  });
  const owner = await signInClubOwner(browser, isolatedTenant);
  try {
    const lesson = await seedLesson({
      club: isolatedTenant,
      venue,
      coach: { userId: coach.userId, linkId },
      playerId: player.userId,
      minutesFromNow: 26 * 60,
    });
    await deskCancelsTheLesson(
      owner.page,
      isolatedTenant,
      { day: lesson.day, coachName: coach.name },
      { shots: SHOTS, tag: 'desktop' },
    );
  } finally {
    await owner.close();
    await clearCoachLinks(coach.userId);
    await destroyClubVenue(venue);
  }
});
