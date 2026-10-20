import bg from '../../messages/bg.json';
import { expect, test as base } from './fixtures';
import { expectAxeClean } from './utils/venue-booking-journey';
import { savedOutline, seedPlanClub, type PlanClub } from './utils/plan-editor-club';

/**
 * The club's plan editor at 1280 px (#626): from Кортове to the venue's plan,
 * draw the court, drag it east on the canvas, save, and it is the club's. The
 * panel's numbers, undo and taking a court off are
 * tests/rendered/plan-editor.test.tsx's.
 */
const p = bg.admin.courts.plan;
const test = base.extend<{ club: PlanClub }>({
  club: async ({ isolatedTenant }, use) => {
    await use(await seedPlanClub(isolatedTenant));
  },
});

test.describe('the plan editor, 1280 px', () => {
  test('draw a court, drag it, save: the outline is the club’s', async ({
    authedPage: page,
    club,
  }) => {
    await page.goto(`/t/${club.slug}/admin/courts`);
    await page.getByRole('link', { name: p.open.replace('{venue}', 'Главен обект') }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/courts/plan/${club.venueId}$`));
    await expect(page.getByText(p.empty)).toBeVisible();

    await page.getByRole('button', { name: p.draw }).click();
    await expect(page.getByText('1 незапазена промяна')).toBeVisible();
    await expectAxeClean(page);

    // The only court is the middle of the fitted plan: drag it 120 px east.
    const canvas = page.getByRole('img', { name: p.canvas });
    const box = (await canvas.boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 5 });
    await page.mouse.move(x + 120, y, { steps: 5 });
    await page.mouse.up();

    await page.getByRole('button', { name: p.save }).click();
    await expect(page.getByText(p.saved)).toBeVisible();

    const saved = await savedOutline(club.courtId);
    expect(saved.planSource).toBe('CLUB');
    const xs = (saved.planOutline as [number, number][]).map((pt) => pt[0]);
    // Drawn at the venue's point (-10..10 m), then moved east, still 20 m long.
    expect(Math.min(...xs)).toBeGreaterThan(-9);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 1);
  });
});
