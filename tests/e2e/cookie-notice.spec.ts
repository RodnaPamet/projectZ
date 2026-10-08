import { test } from './fixtures';
import { cookieNotice, noNoticeInTheShell } from './utils/legal-journey';

/**
 * The essential-only notice at 1280 px (#370). The 393 px twin, where it must
 * stand above the tab bar, is mobile/cookie-notice.spec.ts.
 */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;
const shot = (name: string) => (SHOTS ? `${SHOTS}/370-${name}-1280.png` : undefined);

test.describe('the cookie notice — desktop', () => {
  test('a visitor: shown once, clear of the header, hidden for good on a tap', async ({ page }) => {
    await cookieNotice(page, { shot: shot('cookie-notice') });
  });

  test('a signed-in account: none in the shell', async ({ playerPage: page }) => {
    await noNoticeInTheShell(page);
  });
});
