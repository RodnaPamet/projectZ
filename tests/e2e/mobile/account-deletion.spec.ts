import { expect, test } from '../fixtures';
import {
  blockedAndExport,
  clubProfile,
  deleteAccountFromProfile,
  destroyDeletionClub,
  seedBlockingBookings,
} from '../utils/account-deletion-journey';

/**
 * Deleting an account and downloading its data on a 393 px phone (#370): the
 * desktop journeys, and nothing on /me/profile drifts sideways. The dialog
 * opens as the vendored modal's drawer here.
 */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;
const shot = (name: string) => (SHOTS ? `${SHOTS}/370-${name}-393.png` : undefined);

test.describe('account deletion and export — 393 px', () => {
  test('upcoming bookings hold the button back; the export downloads; no drift', async ({
    playerPage: page,
    player,
  }) => {
    const club = await seedBlockingBookings(player.userId);
    try {
      await blockedAndExport(page, club, { shot: shot('profile-blocked') });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    } finally {
      await destroyDeletionClub(club);
    }
  });

  test('no upcoming booking: type the word, the account is gone, signed out', async ({
    playerPage: page,
  }) => {
    await deleteAccountFromProfile(page, {
      ...(SHOTS
        ? {
            shots: {
              allowed: shot('profile-allowed')!,
              dialog: shot('delete-dialog')!,
              landing: shot('deleted-landing')!,
            },
          }
        : {}),
    });
  });

  test('a club account is told to write in instead', async ({ staffPage: page }) => {
    await clubProfile(page, { shot: shot('profile-club') });
  });
});
