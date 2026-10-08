import type { Page } from '@playwright/test';

/**
 * A club's name longer than the top bar has room for (#362). The bar caps the
 * name, but a capped name still left too little for the left slot.
 */
export const LONG_CLUB_NAME = 'Тенис клуб Левски София – Борисова градина';

/**
 * The room, in px, between the right edge of what the top bar's left slot
 * paints (the wordmark, or the trail) and the left edge of its right slot.
 * Negative when the left slot runs on underneath the right one: upstream's
 * right slot never shrinks, and the left one's content can overflow it.
 */
export function leftSlotClearance(page: Page): Promise<number> {
  return page.getByTestId('nav-bar').evaluate((bar) => {
    const left = bar.querySelector('[data-slot="left"]')!;
    const right = bar.querySelector('[data-slot="right"]')!;
    let painted = left.getBoundingClientRect().left;
    for (const el of Array.from(left.querySelectorAll<HTMLElement>('*'))) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || el.closest('.sr-only')) continue;
      painted = Math.max(painted, box.right);
    }
    return Math.round(right.getBoundingClientRect().left - painted);
  });
}
