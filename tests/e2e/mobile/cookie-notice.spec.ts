import { test } from '../fixtures';
import { cookieNotice, noNoticeInTheShell } from '../utils/legal-journey';

/**
 * The essential-only notice on a 393 px phone (#370): above the bottom tab
 * bar, never over a tab, and gone for good once hidden.
 */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;
const shot = (name: string) => (SHOTS ? `${SHOTS}/370-${name}-393.png` : undefined);

test.describe('the cookie notice — 393 px', () => {
  test('a visitor: above the tab bar, hidden for good on a tap', async ({ page }) => {
    await cookieNotice(page, { shot: shot('cookie-notice'), phone: true });
  });

  test('a signed-in account: none in the shell', async ({ playerPage: page }) => {
    await noNoticeInTheShell(page);
  });
});
