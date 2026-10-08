import { test } from './fixtures';
import {
  contactFormLine,
  deleteAccountHelp,
  footerLinks,
  legalRoutes,
} from './utils/legal-journey';

/**
 * The legal pages and /delete-account at 1280 px (#370, #445). The 393 px twin
 * is mobile/legal-pages.spec.ts. `PLAYERZ_SHOTS_DIR` saves the screenshots.
 */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;
const shot = (name: string) => (SHOTS ? `${SHOTS}/370-${name}-1280.png` : undefined);

test.describe('legal pages and the deletion help — desktop', () => {
  test('a legal page without its text is a real 404', async ({ page }) => {
    await legalRoutes(page);
  });

  test('nothing links to a missing text: the footer, the contact form', async ({ page }) => {
    await footerLinks(page);
    await contactFormLine(page);
  });

  test('/delete-account says how, for anyone', async ({ page }) => {
    await deleteAccountHelp(page, { shot: shot('delete-account-help') });
  });

  test('/delete-account, signed in: the same page, in the shell', async ({ playerPage: page }) => {
    await deleteAccountHelp(page);
  });
});
