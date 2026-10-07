import { test } from '@playwright/test';

import {
  clickFacebook,
  expectDialogRequest,
  refusedForNoEmail,
} from './utils/facebook-sign-in-journey';

/**
 * "Вход с Facebook" at 1280 px (#361). tests/e2e/mobile/facebook-sign-in.spec.ts
 * walks the same journey at 393 px.
 *
 * Meta is never loaded: the Login Dialog is intercepted and read, so these
 * check what the app SENDS — the version, the exact `redirect_uri` Meta has
 * registered in strict mode, and a scope that asks for the email.
 */
test.describe('Facebook sign-in — desktop', () => {
  test('heads to the Login Dialog with the registered redirect_uri and the email scope', async ({
    page,
    baseURL,
  }) => {
    const nextAuthUrl = process.env.NEXTAUTH_URL ?? baseURL!;
    const dialog = await clickFacebook(page, '/me/bookings');

    expectDialogRequest(dialog, nextAuthUrl);
  });

  test('no email from Facebook: says why, keeps the destination, and asks again', async ({
    page,
    baseURL,
  }) => {
    await refusedForNoEmail(page, '/me/bookings', process.env.NEXTAUTH_URL ?? baseURL!);
  });
});
