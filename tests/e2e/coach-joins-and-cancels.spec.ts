import { test } from './fixtures';
import { destroyClubVenue, seedClubVenue } from './utils/club-page-journey';
import {
  approveCoach,
  clearCoachLinks,
  seedTeaching,
  signInElsewhere,
} from './utils/coach-links-journey';
import {
  clubInvitesCoach,
  coachAcceptsTheInvitation,
  playerCancelsTheLesson,
} from './utils/coach-invite-journey';
import { playerBooksALesson } from './utils/lesson-booking-journey';

/**
 * A coach joins a club the club's way, and a player cancels a lesson (#552),
 * in real browsers. The phone's run is mobile/coach-joins-and-cancels.spec.ts. `PLAYERZ_SHOTS_DIR`
 * saves the screenshots.
 */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;

test('a club invites a coach by email; the coach accepts and teaches at its venue at once', async ({
  coachPage,
  coach,
  isolatedTenant,
}) => {
  const venue = await seedClubVenue(
    isolatedTenant.tenantId,
    `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  );
  await approveCoach(coach.userId, isolatedTenant.userId);
  try {
    const token = await clubInvitesCoach(isolatedTenant, coach.email);
    await coachAcceptsTheInvitation(
      coachPage,
      { token, club: isolatedTenant, venue },
      { shots: SHOTS, tag: 'desktop' },
    );
  } finally {
    await clearCoachLinks(coach.userId);
    await destroyClubVenue(venue);
  }
});

test('a player books a lesson and cancels it; the coach’s «Уроци» no longer has it', async ({
  browser,
  playerPage,
  coach,
  isolatedTenant,
}) => {
  test.slow();
  const venue = await seedClubVenue(
    isolatedTenant.tenantId,
    `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  );
  const slug = await approveCoach(coach.userId, isolatedTenant.userId);
  const linkId = await seedTeaching(
    coach.userId,
    { tenantId: isolatedTenant.tenantId, venueId: venue.venueId },
    4000,
    { allWeek: true },
  );
  const teacher = await signInElsewhere(browser, coach);
  try {
    const seen = await playerBooksALesson(playerPage, { slug, name: coach.name, linkId }, venue, {
      tag: 'cancel-desktop',
    });
    await playerCancelsTheLesson(
      playerPage,
      teacher.page,
      { seen, clubSlug: isolatedTenant.tenantSlug },
      { shots: SHOTS, tag: 'desktop' },
    );
  } finally {
    await playerPage.goto('about:blank');
    await teacher.close();
    await clearCoachLinks(coach.userId);
    await destroyClubVenue(venue);
  }
});
