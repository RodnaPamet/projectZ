import { expect, type Locator } from '@playwright/test';

/** Below Tailwind's `sm`, the vendored Popover opens as a bottom sheet. */
const SHEET_BELOW_PX = 640;

/**
 * Wait until a Popover trigger is the phone sheet's, on a phone viewport.
 *
 * The vendored Popover renders its desktop dropdown first and swaps to the
 * bottom sheet after hydration (`useMediaQuery`), re-mounting the trigger. A
 * key press or tap that lands before the swap opens nothing, and a box read
 * across it comes back null. The sheet's trigger carries `sm:hidden`, so wait
 * for that. On a wider viewport there is no swap and this returns at once.
 */
export async function sheetTriggerReady(trigger: Locator) {
  const width = trigger.page().viewportSize()?.width ?? Infinity;
  if (width >= SHEET_BELOW_PX) return;
  await expect(trigger).toHaveClass(/(^|\s)sm:hidden(\s|$)/);
}
