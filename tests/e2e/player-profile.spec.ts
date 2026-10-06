import { test } from './fixtures';
import { setNameAndLevels } from './utils/profile-journey';

/**
 * /me/profile's #359 sections at 1280 px: a display name, and sports with a
 * self-declared 1–7 level each, saved through PATCH /api/v1/me and there again
 * after a reload. The 393 px twin is mobile/player-profile.spec.ts.
 */
test.describe('player profile — desktop', () => {
  test('set a name and levels, then see them', async ({ playerPage: page }) => {
    await setNameAndLevels(page);
  });
});
