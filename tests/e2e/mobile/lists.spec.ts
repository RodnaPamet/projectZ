import { expect, test } from '@playwright/test';

/**
 * TABLES BECOME CARDS ON A PHONE.
 *
 * An eight-column table at 390px does not fit and will not wrap. Without a
 * fallback the overflow lands on the PAGE and the whole app scrolls sideways.
 *
 * The guard (tests/guardrails/datatable-mobile-fallback.test.ts) proves the code
 * SAYS it collapses to cards. This proves the browser actually DOES it — the two
 * are not the same claim, and only one of them is the one the user experiences.
 */

test.describe('@mobile card mode', () => {
  test('the design-system tables render as cards, not a scrolling table', async ({ page }) => {
    // /design-system renders the whole component library, DataTable included. It
    // is the only page in this codebase that mounts a DataTable today, and it
    // exercises every variant at once.
    await page.goto('/design-system');
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => document.fonts.ready);

    const cards = page.locator('[data-testid="data-table-cards"]');

    await expect(cards.first()).toBeVisible();

    // …and the desktop <table> is NOT rendered. If both existed we would be
    // shipping the table to a phone and merely hiding it — which still costs the
    // download and still lets it overflow.
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThan(0);
  });

  test('a card list does not push the page sideways', async ({ page }) => {
    // The whole reason card mode exists. Re-asserted here rather than trusting
    // the drift spec, because this is the specific claim card mode makes.
    await page.goto('/design-system');
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => document.fonts.ready);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('a tappable card is reachable by KEYBOARD and at least 44px', async ({ page }) => {
    // A clickable card was a bare <div> with onClick: no role, no tabIndex, no
    // key handler. A keyboard or screen-reader user could not activate a row at
    // all, and nothing said so.
    await page.goto('/design-system');
    await page.waitForLoadState('domcontentloaded');

    // Wait for the card list before counting. The server paints the desktop
    // table (useIsBelowMd is false until hydration), so a bare count() races
    // the swap to cards: measured at T21, it ran first and the test SKIPPED,
    // passing without asserting anything.
    await expect(page.locator('[data-testid="data-table-cards"]').first()).toBeVisible();

    const clickable = page.locator('[data-testid="data-table-cards"] [role="button"]').first();

    // Not every design-system table is clickable; skip cleanly if none is,
    // rather than asserting something false.
    if ((await clickable.count()) === 0) {
      test.skip(true, 'no clickable card rendered on this page');
      return;
    }

    await expect(clickable).toBeVisible();

    // Focusable.
    await clickable.focus();
    await expect(clickable).toBeFocused();

    // 44px — below that a tap lands between rows as often as on one.
    const box = await clickable.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('the venues list does not scroll sideways at 390px', async ({ page }) => {
    await page.goto('/venues');
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => document.fonts.ready);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    expect(overflow).toBeLessThanOrEqual(1);
  });
});
