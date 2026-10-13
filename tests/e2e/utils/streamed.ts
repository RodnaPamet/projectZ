import { expect, type Page } from '@playwright/test';

/**
 * Wait until the page's streamed content is in place.
 *
 * ═══ WHY EVERY SPEC THAT NAVIGATES NEEDS THIS (#405) ═══
 *
 * A page with a `loading.tsx` is sent in two parts: the skeleton first, and
 * the page later, as `<div hidden id="S:n">…</div>` plus a script that swaps
 * it in. React 19 holds that swap back for up to its 300 ms reveal throttle.
 * Until then the page's markup is in the DOM twice in effect: hidden, and
 * about to be shown.
 *
 * `getByTestId`, `getByText` and CSS locators match hidden nodes. So a check
 * made in that window fails strict mode on two elements, or measures the
 * hidden copy (a `boundingBox()` of null). Role locators skip hidden nodes,
 * which is why some specs never noticed and others rediscovered this one at a
 * time, each with a workaround of its own.
 *
 * Call it after `page.goto(…)`, and after a click that navigates when the
 * next check is not by role. It passes at once on a page that streams nothing.
 */
export async function streamed(page: Page) {
  await expect(page.locator('div[hidden][id^="S:"]')).toHaveCount(0);
}
