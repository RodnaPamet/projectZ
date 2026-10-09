import type { Locator } from '@playwright/test';

/**
 * Waits until an overlay that has just opened has finished animating in, so
 * that axe checks it at rest (#463).
 *
 * `toBeVisible()` passes on the first frame of an opening animation. axe
 * blends a translucent ancestor into its colour-contrast maths, so a popover
 * still fading in reads as lighter text: the account menu's unselected "EN"
 * once scored 4.42 against the 4.5 it scores at rest.
 *
 * It waits for the animations and transitions on the overlay, inside it and
 * ABOVE it. The popover's fade (`animate-slide-up-fade`) sits on Radix's
 * content wrapper, the parent of the `role="menu"` or `role="listbox"` a spec
 * holds, so the overlay's own subtree alone would miss it. Infinite
 * animations (a skeleton's shimmer) never finish and are left out, and so is
 * anything paused.
 */
export async function settleAnimations(overlay: Locator): Promise<void> {
  await overlay.evaluate(async (el) => {
    const animations = el.getAnimations({ subtree: true });
    for (let up = el.parentElement; up; up = up.parentElement) {
      animations.push(...up.getAnimations());
    }
    await Promise.all(
      animations
        .filter(
          (a) => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity,
        )
        // A cancelled animation rejects `finished`; it is no longer running.
        .map((a) => a.finished.catch(() => undefined)),
    );
  });
}
