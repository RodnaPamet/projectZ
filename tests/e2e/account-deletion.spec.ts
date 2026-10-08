import { test } from './fixtures';
import {
  blockedAndExport,
  clubProfile,
  deleteAccountFromProfile,
  destroyDeletionClub,
  seedBlockingBookings,
} from './utils/account-deletion-journey';

/**
 * Deleting an account and downloading its data on /me/profile at 1280 px
 * (#370). The 393 px twin is mobile/account-deletion.spec.ts.
 * `PLAYERZ_SHOTS_DIR` (a directory) saves the screenshots for the PR.
 */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;
const shot = (name: string) => (SHOTS ? `${SHOTS}/370-${name}-1280.png` : undefined);

test.describe('account deletion and export — desktop', () => {
  test('upcoming bookings hold the button back; the export downloads', async ({
    playerPage: page,
    player,
  }) => {
    const club = await seedBlockingBookings(player.userId);
    try {
      await blockedAndExport(page, club, { shot: shot('profile-blocked') });
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
