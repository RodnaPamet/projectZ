import { expect, test } from '@playwright/test';

import { THEME_COOKIE, THEME_STORAGE_KEY } from '../../src/lib/theme-constants';

/**
 * A FIRST VISIT IS IN THE VISITOR'S OWN SCHEME FROM THE FIRST FRAME (#286).
 *
 * `design-system-dark-axe` covers a returning visitor: a theme cookie, read by
 * the server, so the first byte already carries `data-theme`. Nothing covered
 * the case the acceptance criterion was written for: no cookie at all.
 *
 * With no cookie the server sends `<html>` with no `data-theme`, and the
 * pre-paint script in <head> (src/app/layout.tsx) sets it from
 * `prefers-color-scheme` before the body paints. If that script lost its race,
 * a light-preferring visitor would see the dark `:root` palette for a frame:
 * the flash #283 fixed, and that a 150 ms transition once let axe sample
 * mid-flight (#115).
 *
 * So the theme is recorded at every animation frame from the first one that
 * has a body to paint, by a script that runs before any of the page's own,
 * and every frame must agree.
 *
 * ═══ AND NOTHING IS STORED (#370) ═══
 *
 * A theme is kept only when somebody picks one. Following the OS needs no
 * storage, and a one-year cookie copied from it on every first visit is not a
 * preference anybody asked us to keep (owner decision 2026-10-08, the cookie
 * audit). So a first visit leaves no theme cookie and no theme in
 * localStorage. An earlier note on this issue asked for the opposite; that was
 * before the audit.
 */
for (const scheme of ['light', 'dark'] as const) {
  test(`first visit on a ${scheme} OS: ${scheme} from the first frame, and nothing stored`, async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.emulateMedia({ colorScheme: scheme });

    // Before any script of the page: record the theme at every frame.
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __themeFrames: string[] }).__themeFrames = seen;
      const tick = () => {
        // Only frames with something to paint: the pre-paint script sits in
        // <head>, so it has run by the time there is a <body> at all. A frame
        // before that draws nothing, whatever the attribute says.
        if (document.body) {
          seen.push(document.documentElement.getAttribute('data-theme') ?? '(none)');
        }
        if (seen.length < 60) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await page.goto('/venues');
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);

    // Let a few more frames pass, hydration included, then read them all.
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { __themeFrames: string[] }).__themeFrames.length,
        ),
      )
      .toBeGreaterThanOrEqual(10);
    const frames = await page.evaluate(
      () => (window as unknown as { __themeFrames: string[] }).__themeFrames,
    );
    // Not one frame without a theme, and not one in the other one.
    expect([...new Set(frames)]).toEqual([scheme]);

    // Followed, not stored.
    const cookies = await context.cookies();
    expect(cookies.filter((c) => c.name === THEME_COOKIE)).toEqual([]);
    expect(await page.evaluate((key) => localStorage.getItem(key), THEME_STORAGE_KEY)).toBeNull();
  });
}
