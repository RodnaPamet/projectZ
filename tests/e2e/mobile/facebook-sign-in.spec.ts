import { expect, test } from '@playwright/test';

import bg from '../../../messages/bg.json';
import {
  clickFacebook,
  expectDialogRequest,
  refusedForNoEmail,
} from '../utils/facebook-sign-in-journey';

/**
 * "Вход с Facebook" at 393 px (Pixel 5, #361): the same journey as the 1280 px
 * spec, with the button a full touch target.
 */
test.describe('Facebook sign-in — 393 px', () => {
  test('heads to the Login Dialog with the registered redirect_uri and the email scope', async ({
    page,
    baseURL,
  }) => {
    const nextAuthUrl = process.env.NEXTAUTH_URL ?? baseURL!;
    const dialog = await clickFacebook(page, '/me/bookings');

    expectDialogRequest(dialog, nextAuthUrl);
  });

  test('the button is a full touch target', async ({ page }) => {
    await page.goto('/login');
    const box = await page.getByRole('button', { name: bg.login.withFacebook }).boundingBox();

    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('no email from Facebook: says why, keeps the destination, and asks again', async ({
    page,
    baseURL,
  }) => {
    await refusedForNoEmail(page, '/me/bookings', process.env.NEXTAUTH_URL ?? baseURL!);
  });
});
