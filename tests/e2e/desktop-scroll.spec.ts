import { expect, test, type Page } from '@playwright/test';

/**
 * A DESKTOP PAGE SCROLLS WHEN A PERSON SCROLLS IT.
 *
 * globals.css used to lock html and body to the viewport at 768px and up
 * (height 100%, overflow hidden) — inflect's list-page-shell contract, which
 * assumes an AppShell whose inner container owns the scroll. No playerz page
 * has one, so on a laptop or an iPad the document could not move: everything
 * below the first screen of /design-system was unreachable.
 *
 * Nothing caught it because every check scrolled PROGRAMMATICALLY.
 * `scrollIntoView`, `locator.click()` and `toBeVisible()`'s auto-scroll all
 * move an `overflow: hidden` box happily; a wheel or a key press does not.
 * So this spec uses ONLY what a person uses — the mouse wheel and PageDown —
 * and never a locator action that could scroll on its behalf.
 *
 * The lock now applies only under `html:has([data-scroll-root])` (the shell
 * that owns its scroll, T19); tests/guardrails/document-scroll-lock.test.ts
 * holds the CSS, this holds the behaviour.
 */

const scrollTop = (page: Page) => page.evaluate(() => document.scrollingElement?.scrollTop ?? 0);

/** Is the last design-system section at least partly inside the viewport? */
const lastSectionInView = (page: Page) =>
  page.evaluate(() => {
    const sections = document.querySelectorAll('[data-testid^="ds-section-"]');
    const last = sections[sections.length - 1];
    if (!last) return false;
    const box = last.getBoundingClientRect();
    return box.top < window.innerHeight && box.bottom > 0;
  });

/** Scroll with `step` until the document stops moving (bottom) or 40 steps. */
async function scrollToBottom(page: Page, step: () => Promise<void>) {
  let previous = -1;
  for (let i = 0; i < 40; i++) {
    await step();
    // Let the scroll land before measuring; wheel scrolling is async.
    await page.waitForTimeout(50);
    const now = await scrollTop(page);
    if (now === previous) break;
    previous = now;
  }
}

test.describe('desktop pages scroll', () => {
  test('/design-system scrolls to its last section with the mouse wheel at 1280x800', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/design-system');
    await expect(page.locator('html')).toHaveAttribute('data-theme', /^(dark|light)$/);

    // The premise: the page is taller than the viewport, or "it scrolled"
    // would be vacuous.
    const { scrollHeight, clientHeight } = await page.evaluate(() => ({
      scrollHeight: document.scrollingElement!.scrollHeight,
      clientHeight: document.scrollingElement!.clientHeight,
    }));
    expect(scrollHeight).toBeGreaterThan(clientHeight * 2);
    expect(await lastSectionInView(page)).toBe(false);

    await page.mouse.move(640, 400);
    await scrollToBottom(page, () => page.mouse.wheel(0, 900));

    expect(await scrollTop(page)).toBeGreaterThan(0);
    expect(await lastSectionInView(page)).toBe(true);
  });

  test('/design-system scrolls with PageDown on an 820x1180 touch tablet', async ({ browser }) => {
    // An iPad-Air-sized portrait tablet: above md, so the old lock applied,
    // and touch-capable, which is where "scroll the page" matters most.
    const context = await browser.newContext({
      viewport: { width: 820, height: 1180 },
      hasTouch: true,
    });
    const page = await context.newPage();

    try {
      await page.goto('/design-system');
      await expect(page.locator('html')).toHaveAttribute('data-theme', /^(dark|light)$/);
      expect(await lastSectionInView(page)).toBe(false);

      await scrollToBottom(page, () => page.keyboard.press('PageDown'));

      expect(await scrollTop(page)).toBeGreaterThan(0);
      expect(await lastSectionInView(page)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test('/venues does not lock the document when no [data-scroll-root] exists', async ({ page }) => {
    // The e2e seed has two venues, so /venues does not overflow at 1280 and a
    // scroll assertion would prove nothing. What CAN be checked is the thing
    // that made every desktop page unscrollable: the computed overflow.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/venues');

    const state = await page.evaluate(() => ({
      scrollRoot: document.querySelector('[data-scroll-root]') !== null,
      html: getComputedStyle(document.documentElement).overflowY,
      body: getComputedStyle(document.body).overflowY,
    }));

    expect(state.scrollRoot).toBe(false);
    expect(state.html).not.toBe('hidden');
    expect(state.body).not.toBe('hidden');
  });
});
