import { devices } from '@playwright/test';

import { test } from '../fixtures';
import {
  approveFromQueue,
  clearCoach,
  fillInAndSend,
  seesApproval,
  signInOwner,
} from '../utils/coach-approval-journey';

/**
 * The coach approval journey (#545) on a phone: the coach on theirs, and the
 * owner's queue on one too. Same steps as the desktop spec.
 */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;

test('phone: a coach sends a profile, the owner approves it', async ({
  browser,
  coach,
  coachPage,
  isolatedTenant,
}) => {
  test.slow();
  const owner = await signInOwner(browser, isolatedTenant.userId, { ...devices['Pixel 5'] });
  try {
    await fillInAndSend(coachPage, { shots: SHOTS, tag: 'phone' });
    await approveFromQueue(owner, coach, { shots: SHOTS, tag: 'phone' });
    await seesApproval(coachPage, coach.userId, { shots: SHOTS, tag: 'phone' });
  } finally {
    await owner.close();
    await clearCoach(coach.userId);
  }
});
