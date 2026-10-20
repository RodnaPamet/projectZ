import bg from '../../messages/bg.json';
import { expect, test as base } from './fixtures';
import {
  destroyBookableVenue,
  seedBookableVenue,
  type BookableVenue,
} from './utils/seed-bookable-venue';
import { expectAxeClean, pickTomorrow } from './utils/venue-booking-journey';
import { drawTheCourt } from './utils/venue-plan';

/**
 * The venue plan at 1280 px (#625): what only a browser can show. The canvas
 * paints, a tap on a free court is the pick, the pointer on a court lights its
 * card, and zoom comes back to the whole plan. The words around it are
 * tests/rendered/venue-plan.test.tsx's.
 */
const v = bg.venue;
const p = v.plan;
const test = base.extend<{ venue: BookableVenue }>({
  venue: async ({ player }, use) => {
    void player;
    const venue = await seedBookableVenue();
    await drawTheCourt(venue);
    await use(venue);
    await destroyBookableVenue(venue);
  },
});

test.describe('the venue plan, 1280 px', () => {
  test('pick a time, tap the court: it is the pick', async ({ playerPage: page, venue }) => {
    await page.goto(`/venues/${venue.publicSlug}`);
    await pickTomorrow(page, venue);

    const plan = page.getByRole('img', { name: p.label });
    await expect(plan).toBeVisible();
    await expect(page.locator('[data-plan-ready]')).toHaveCount(1);
    const first = page.getByRole('radiogroup', { name: p.timeLabel }).getByRole('radio').first();
    await expect(first).toHaveAttribute('aria-checked', 'true');
    const start = (await first.textContent())!;

    // The court is the whole plan, so the canvas's middle is the court's.
    await plan.click();
    const times = page.getByRole('group', { name: 'Часове, Корт 1' });
    await expect(times.getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page.getByText(p.statePicked.replace('{court}', 'Корт 1').replace('{time}', start)),
    ).toBeAttached();
    await expect(page.getByRole('button', { name: v.book })).toBeEnabled();
    // Drawn by the club, not from OpenStreetMap: no credit owed.
    await expect(page.getByRole('link', { name: p.credit })).toHaveCount(0);
    await expectAxeClean(page);
  });

  test('the pointer on a court lights its card', async ({ playerPage: page, venue }) => {
    await page.goto(`/venues/${venue.publicSlug}`);
    await pickTomorrow(page, venue);
    const card = page.locator('article', {
      has: page.getByRole('heading', { level: 3, name: 'Корт 1' }),
    });

    await page.getByRole('img', { name: p.label }).hover();
    await expect(card).toHaveClass(/ring-2/);
    await page.getByRole('heading', { level: 1 }).hover();
    await expect(card).not.toHaveClass(/ring-2/);
  });

  test('zoom in, then back to the whole plan', async ({ page, venue }) => {
    await page.goto(`/venues/${venue.publicSlug}`);
    await expect(page.locator('[data-plan-ready]')).toHaveCount(1);
    const zoomOut = page.getByRole('button', { name: p.zoomOut });
    await expect(zoomOut).toBeDisabled();

    await page.getByRole('button', { name: p.zoomIn }).click();
    await expect(zoomOut).toBeEnabled();
    await page.getByRole('button', { name: p.fit }).click();
    await expect(zoomOut).toBeDisabled();
    await expect(page.getByRole('button', { name: p.fit })).toHaveCount(0);
  });
});
