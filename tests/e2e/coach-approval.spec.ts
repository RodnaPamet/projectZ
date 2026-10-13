import { expect, test } from './fixtures';
import {
  approveFromQueue,
  clearCoach,
  fillInAndSend,
  seesApproval,
  signInOwner,
} from './utils/coach-approval-journey';

/**
 * A coach's profile, from empty to approved (#545; owner decisions 13, 17),
 * in real browsers: the coach's and the platform owner's. The phone's run is
 * mobile/coach-approval.spec.ts. `PLAYERZ_SHOTS_DIR` saves the screenshots.
 */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;

test('a coach fills in a profile and sends it; the owner reads the certificate and approves', async ({
  browser,
  coach,
  coachPage,
  isolatedTenant,
}) => {
  test.slow();
  const owner = await signInOwner(browser, isolatedTenant.userId);
  try {
    await fillInAndSend(coachPage, { shots: SHOTS, tag: 'desktop' });
    await approveFromQueue(owner, coach, { shots: SHOTS, tag: 'desktop' });
    await seesApproval(coachPage, coach.userId, { shots: SHOTS, tag: 'desktop' });
  } finally {
    await owner.close();
    await clearCoach(coach.userId);
  }
});

test('the coach profile is for coaches: a player is sent to their own profile', async ({
  playerPage,
}) => {
  await playerPage.goto('/me/coach');
  await expect(playerPage).toHaveURL(/\/me\/profile$/);
});

test('the queue is not there without the grant: a coach and a club owner get a 404', async ({
  coachPage,
}) => {
  const res = await coachPage.goto('/platform/coaches');
  expect(res?.status()).toBe(404);
});
