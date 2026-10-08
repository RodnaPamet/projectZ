import { expect, test } from '../fixtures';
import { deleteAccountHelp, footerLinks, legalRoutes } from '../utils/legal-journey';

/**
 * The legal pages and /delete-account on a 393 px phone (#370, #445): the
 * desktop journeys, and the help page does not drift sideways.
 */
const SHOTS = process.env.PLAYERZ_SHOTS_DIR;
const shot = (name: string) => (SHOTS ? `${SHOTS}/370-${name}-393.png` : undefined);

test.describe('legal pages and the deletion help — 393 px', () => {
  test('a legal page without its text is a real 404', async ({ page }) => {
    await legalRoutes(page);
  });

  test('the footer links what exists, and the deletion help always', async ({ page }) => {
    await footerLinks(page);
  });

  test('/delete-account reads on a phone, with no drift', async ({ page }) => {
    await deleteAccountHelp(page, { shot: shot('delete-account-help') });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
