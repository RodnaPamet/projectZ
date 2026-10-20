import bg from '../../../messages/bg.json';
import { expect, test as base } from '../fixtures';
import { savedOutline, seedPlanClub, type PlanClub } from '../utils/plan-editor-club';
import { expectNoDrift } from '../utils/venue-booking-journey';

/**
 * The club's plan editor at 393 px (Pixel 5, #626): the front desk's phone.
 * It fits without scrolling sideways, and a court is drawn, moved by the metre
 * and saved with thumbs alone.
 */
const p = bg.admin.courts.plan;
const test = base.extend<{ club: PlanClub }>({
  club: async ({ isolatedTenant }, use) => {
    await use(await seedPlanClub(isolatedTenant));
  },
});

test.describe('the plan editor, 393 px', () => {
  test('draw, move a metre east, save', async ({ authedPage: page, club }) => {
    await page.goto(`/t/${club.slug}/admin/courts/plan/${club.venueId}`);
    await expect(page.getByRole('img', { name: p.canvas })).toBeVisible();
    await expectNoDrift(page);

    await page.getByRole('button', { name: p.draw }).tap();
    await page.getByRole('button', { name: p.east }).tap();
    await page.getByRole('button', { name: p.save }).tap();
    await expect(page.getByText(p.saved)).toBeVisible();
    await expectNoDrift(page);

    const xs = ((await savedOutline(club.courtId)).planOutline as [number, number][]).map(
      (pt) => pt[0],
    );
    expect(Math.min(...xs)).toBeCloseTo(-9);
  });
});
