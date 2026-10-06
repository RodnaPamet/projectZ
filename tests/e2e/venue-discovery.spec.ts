import { expect, test } from '@playwright/test';

import bg from '../../messages/bg.json';

/**
 * The public discovery flow, driven through a real browser against a real
 * database — the path every player takes before they ever sign in.
 *
 * ═══ THIS PAGE IS BULGARIAN, INCLUDING BEFORE SIGN-IN ═══
 *
 * The heading assertion read `name: 'Play'` and broke the moment the default
 * locale became real. That is the deliberate difference from agri-saas, whose
 * pre-login pages stay English precisely so its specs do not have to care —
 * playerz.bg's pre-login page is the shop window, so it is Bulgarian and this
 * spec follows.
 *
 * Asserted FROM THE CATALOGUE rather than retyped. A reworded heading is not a
 * regression and should not fail here; a heading that stops rendering, or a
 * key that disappears, still does.
 */
test.describe('venue discovery', () => {
  test('the venues page lists venues', async ({ page }) => {
    await page.goto('/venues');

    await expect(page.getByRole('heading', { level: 1, name: bg.venues.title })).toBeVisible();

    const cards = page
      .getByRole('main')
      .getByRole('listitem')
      .filter({ hasText: /Sofia|Plovdiv/ });
    await expect(cards.first()).toBeVisible();
  });

  /**
   * #267, turned around by #355. Every card linked to /venues/{slug} before
   * that page existed: a tap was a 404, and each card's viewport prefetch
   * fetched one in the background. Now every card links to its venue page at
   * its public slug, and each of those pages answers.
   */
  test('every venue card links to its venue page, and the page answers', async ({ page }) => {
    await page.goto('/venues');
    const cards = page.getByRole('main').getByRole('listitem');
    await expect(cards.first()).toBeVisible();

    const hrefs = await page
      .locator('main li a[href^="/venues/"]')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
    expect(hrefs.length).toBe(await cards.count());
    for (const href of hrefs.slice(0, 3)) {
      const res = await page.request.get(href);
      expect(res.status(), href).toBe(200);
    }
  });

  test('has no critical or serious accessibility violations', async ({ page }) => {
    const AxeBuilder = (await import('@axe-core/playwright')).default;
    await page.goto('/venues');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );

    const report = blocking
      .map((v) => `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes[0]?.target.join(' ')}`)
      .join('\n');

    expect(blocking, `axe found ${blocking.length} blocking violation(s):\n${report}`).toEqual([]);
  });
});
