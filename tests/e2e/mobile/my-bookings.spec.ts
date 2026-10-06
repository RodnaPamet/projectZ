import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { THEME_COOKIE } from '../../../src/lib/theme-constants';
import { expect, test as base } from '../fixtures';
import { destroyPlayedClub, seedPlayedClub, type PlayedClub } from '../utils/seed-my-bookings';

/**
 * /me/bookings on a 393 px phone (T22): the same list and review as the
 * desktop spec, checked for what a phone adds — 44 px targets on a coarse
 * pointer, no sideways drift with the review form open, and axe in both themes.
 */

const mb = bg.myBookings;
const test = base.extend<{ club: PlayedClub }>({
  club: async ({ player }, use) => {
    const club = await seedPlayedClub(player.userId);
    await use(club);
    await destroyPlayedClub(club, player.userId);
  },
});

const yours = (rating: number) => mb.review.yours.replace('{rating}', String(rating));

async function expectTarget(target: Locator) {
  const box = (await target.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
}

async function expectNoDrift(page: Page) {
  const overflow = await page.evaluate(() =>
    Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth,
    ),
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectAxeClean(page: Page) {
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
}

test.describe('my bookings — phone', () => {
  test('the list and a review, under the thumb, with no drift', async ({
    playerPage: page,
    club,
  }) => {
    await page.goto('/me/bookings');
    const cards = page.locator('[data-perf-ready] > li');
    // Предстоящи, then Минали (#359): one booking each, the tabs under the thumb.
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText(club.venueName);
    await expect(cards.first()).toContainText(mb.status.CONFIRMED);
    const pastTab = page.getByRole('radio', { name: mb.tabs.past });
    await expectTarget(pastTab);
    await expectNoDrift(page);
    await pastTab.click();
    await expect(cards.first()).toContainText(mb.status.COMPLETED);
    await expect(cards).toHaveCount(1);

    const played = cards.first();
    const rate = played.getByRole('button', { name: mb.review.rate });
    await expectTarget(rate);
    await rate.click();

    const submit = played.getByRole('button', { name: mb.review.submit });
    await expectTarget(submit);
    await expectNoDrift(page);

    await played.getByRole('radio').nth(3).click();
    const posted = page.waitForResponse((r) => r.url().endsWith('/review'));
    await submit.click();

    await expect(played).toContainText(yours(4));
    expect((await posted).status()).toBe(201);
    await expect(played).toContainText(mb.review.status.PUBLISHED);
  });

  test('a refusal rolls back and says why', async ({ playerPage: page, club }) => {
    await page.route(`**/api/v1/t/${club.slug}/bookings/*/review`, (route) =>
      route.fulfill({
        status: 409,
        json: { error: { code: 'ALREADY_REVIEWED', message: 'x', requestId: 'req_e2e' } },
      }),
    );
    await page.goto('/me/bookings?tab=past');
    const played = page.locator('[data-perf-ready] > li').first();

    await played.getByRole('button', { name: mb.review.rate }).click();
    await played.getByRole('radio').nth(0).click();
    await played.getByRole('button', { name: mb.review.submit }).click();

    await expect(played.getByRole('alert')).toContainText(mb.review.error.ALREADY_REVIEWED);
    await expect(played.getByRole('button', { name: mb.review.submit })).toBeVisible();
    await expectNoDrift(page);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`axe: the list with a review form open, ${theme}`, async ({
      playerPage: page,
      club: _club,
      baseURL,
    }) => {
      await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: baseURL! }]);
      await page.goto('/me/bookings?tab=past');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.getByRole('button', { name: mb.review.rate }).click();
      // The review's five stars; the Предстоящи / Минали toggle is a radiogroup too.
      await expect(page.locator('[data-perf-ready] > li').first().getByRole('radio')).toHaveCount(
        5,
      );
      await expectAxeClean(page);
    });
  }
});
