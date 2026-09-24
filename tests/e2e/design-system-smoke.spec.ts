import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * P02 — the design-system gallery must render every primitive family,
 * flip themes, and carry zero critical/serious accessibility violations.
 */

const SECTIONS = [
  'Button',
  'Input',
  'Textarea',
  'Checkbox',
  'RadioGroup',
  'Switch',
  'StatusBadge',
  'Skeleton',
  'EmptyState',
  'ErrorState',
  'Tooltip',
  'CopyButton',
  'Modal',
  'Sheet',
  'ConfirmDialog',
  'CalendarMonth',
];

/**
 * Wait until the page is painting its FINAL palette.
 *
 * `page.goto` resolves on `load`, but the palette is NOT settled at that point:
 *
 *   • `src/app/layout.tsx` renders `<html>` with no `data-theme` and no
 *     anti-FOUC inline script, so the server always ships the dark `:root`
 *     tokens.
 *   • `ThemeProvider`'s mount effect then applies the resolved theme — under
 *     Playwright's default `prefers-color-scheme: light`, that is `light`.
 *   • `<Button>` carries `transition-all duration-150` (button-variants.ts), so
 *     the flip ANIMATES its `background-color` and `color` over 150ms, while the
 *     page background behind it (no transition) snaps across instantly.
 *
 * Anything that samples colour inside that window measures a blend the product
 * never settles on. That is what failed on an unchanged tree in issue #115:
 * axe caught the Secondary button's label at ~70% of the flip and reported
 * `#5c5c5b` on `#adaea8` — 2.99:1. Those two values are reproduced exactly by
 * interpolating the dark tokens towards the light ones at that progress; the
 * settled ratios are 14.5:1 (dark) and 11.2:1 (light), both far above AA, and
 * `tests/guardrails/contrast.test.ts` now measures them on every run.
 *
 * Waiting for `data-theme` alone would NOT fix this — the attribute appears at
 * the START of the transition. We wait for the transitions it starts to end.
 */
async function waitForSettledTheme(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^(dark|light)$/);

  await page.evaluate(async () => {
    // TWO frame boundaries, not one. A `requestAnimationFrame` callback runs
    // before the frame's style recalculation, so one frame after the attribute
    // flip the transitions may not have been created yet and `getAnimations()`
    // would return an empty list — a wait that passes by measuring nothing.
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await nextFrame();
    await nextFrame();

    await Promise.allSettled(
      document
        .getAnimations()
        // CSSTransition only: the Skeleton section runs an infinite
        // `animate-pulse` CSSAnimation whose `finished` promise never resolves.
        .filter((animation): animation is CSSTransition => animation instanceof CSSTransition)
        // A transition that gets interrupted REJECTS `finished`, hence
        // allSettled — an interrupted transition is still one we stopped
        // waiting on for the right reason.
        .map((animation) => animation.finished),
    );
  });
}

test.describe('design system', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/design-system');
    await waitForSettledTheme(page);
  });

  test('renders a section for every primitive family', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toContainText('design system');

    for (const section of SECTIONS) {
      await expect(
        page.getByRole('heading', { level: 2, name: section, exact: true }),
        `missing section: ${section}`,
      ).toBeVisible();
    }
  });

  test('theme toggle flips data-theme', async ({ page }) => {
    const html = page.locator('html');
    const before = await html.getAttribute('data-theme');

    await page.getByRole('button', { name: /theme/i }).click();

    await expect
      .poll(async () => html.getAttribute('data-theme'), {
        message: 'data-theme did not change after clicking the toggle',
      })
      .not.toBe(before);
  });

  test('has zero critical or serious axe violations', async ({ page }) => {
    // `beforeEach` has already settled the theme, so colour-contrast is measured
    // against the palette the page actually rests on. See waitForSettledTheme.
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );

    // Surface the actual rule + node so a failure is actionable rather
    // than just a count.
    const report = blocking
      .map((v) => `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.nodes[0]?.target.join(' ')}`)
      .join('\n');

    expect(blocking, `axe found ${blocking.length} blocking violation(s):\n${report}`).toEqual([]);
  });
});
