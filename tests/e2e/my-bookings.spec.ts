import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import bg from '../../messages/bg.json';
import { THEME_COOKIE } from '../../src/lib/theme-constants';
import { expect, test as base } from './fixtures';
import { destroyPlayedClub, seedPlayedClub, type PlayedClub } from './utils/seed-my-bookings';

/**
 * /me/bookings at 1280 px on the client data layer (T22): seeded from the
 * server, revalidated through `GET /api/v1/me/bookings`, and reviewed through
 * the v1 review route, optimistically. The 393 px twin is
 * mobile/my-bookings.spec.ts.
 */

const mb = bg.myBookings;
const test = base.extend<{ club: PlayedClub }>({
  club: async ({ player }, use) => {
    const club = await seedPlayedClub(player.userId);
    await use(club);
    await destroyPlayedClub(club, player.userId);
  },
});

/** `HH:MM` of yesterday's 16:00 UTC, in Sofia — what the card must say. */
function sofiaTime(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(16, 0, 0, 0);
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Europe/Sofia',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('hour')}:${get('minute')}`;
}

const yours = (rating: number) => mb.review.yours.replace('{rating}', String(rating));

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

/** The list's revalidation after paint: the one GET a document load costs. */
const listRead = (page: Page) =>
  page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/v1/me/bookings' && r.request().method() === 'GET',
  );

test.describe('my bookings — desktop', () => {
  test('lists the bookings in the venue’s time, then revalidates through v1', async ({
    playerPage: page,
    club,
  }) => {
    const read = listRead(page);
    await page.goto('/me/bookings');

    await expect(page.getByRole('heading', { level: 1, name: mb.title })).toBeVisible();
    const cards = page.locator('[data-perf-ready] > li');
    // Предстоящи (#359): tomorrow's confirmed booking alone.
    await expect(page.getByRole('radio', { name: mb.tabs.upcoming })).toBeChecked();
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText(club.venueName);
    await expect(cards.first()).toContainText(mb.status.CONFIRMED);
    expect((await read).status()).toBe(200);

    // Минали: yesterday's played one, in Sofia's time; the address follows.
    await page.getByRole('radio', { name: mb.tabs.past }).click();
    await expect(page).toHaveURL(/\/me\/bookings\?tab=past$/);
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText(mb.status.COMPLETED);
    await expect(cards.first()).toContainText(sofiaTime());
  });

  test('a review shows at once, is POSTed to the v1 route, and settles as stored', async ({
    playerPage: page,
    club,
  }) => {
    await page.goto('/me/bookings?tab=past');
    const played = page.locator('[data-perf-ready] > li').first();

    await played.getByRole('button', { name: mb.review.rate }).click();
    await played.getByRole('radio').nth(4).click();

    const posted = page.waitForResponse((r) =>
      r.url().endsWith(`/api/v1/t/${club.slug}/bookings/${club.completedId}/review`),
    );
    await played.getByRole('button', { name: mb.review.submit }).click();

    await expect(played).toContainText(yours(5));
    expect((await posted).status()).toBe(201);
    // A star-only review is published at once; the re-read says so.
    await expect(played).toContainText(mb.review.status.PUBLISHED);
    await expect(played.getByRole('button', { name: mb.review.rate })).toHaveCount(0);

    // And it is stored: a fresh document load shows it from the server seed.
    await page.reload();
    await expect(page.locator('[data-perf-ready] > li').first()).toContainText(yours(5));
  });

  test('a refusal rolls back and says why', async ({ playerPage: page, club }) => {
    await page.route(`**/api/v1/t/${club.slug}/bookings/*/review`, (route) =>
      route.fulfill({
        status: 403,
        json: { error: { code: 'NO_PROOF_OF_VISIT', message: 'x', requestId: 'req_e2e' } },
      }),
    );
    await page.goto('/me/bookings?tab=past');
    const played = page.locator('[data-perf-ready] > li').first();

    await played.getByRole('button', { name: mb.review.rate }).click();
    await played.getByRole('radio').nth(2).click();
    await played.getByLabel(mb.review.bodyLabel).fill('Добро осветление');
    await played.getByRole('button', { name: mb.review.submit }).click();

    await expect(played.getByRole('alert')).toContainText(mb.review.error.NO_PROOF_OF_VISIT);
    await expect(played).not.toContainText(yours(3));
    await expect(played.getByLabel(mb.review.bodyLabel)).toHaveValue('Добро осветление');
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

  test('with no bookings: the empty state, and a way to the venues', async ({
    playerPage: page,
  }) => {
    await page.goto('/me/bookings');
    // Inside <main>: under the 300 ms reveal throttle a streamed page can sit
    // in a hidden copy beside the shown one, and an unscoped text query finds both.
    const main = page.getByRole('main');
    await expect(main.getByText(mb.empty.upcoming.title)).toBeVisible();
    await main.getByRole('link', { name: mb.browse }).click();
    await expect(page).toHaveURL(/\/venues$/);
  });
});
