import type { Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { expect } from '../fixtures';
import { expectAxeClean } from './booking-detail-journey';
import type { ClubVenue } from './club-page-journey';
import { streamed } from './streamed';

/**
 * Finding a coach (#547), signed out, as the desktop and the phone spec both
 * run it: «Треньори», the coach's card, their page, and from there the venue
 * where they teach.
 */

const t = bg.coaches;

const shot = async (page: Page, dir: string | undefined, name: string) => {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
};

export async function findACoach(
  page: Page,
  coach: { slug: string; name: string },
  venue: ClubVenue,
  opts: { shots?: string; tag: string },
) {
  await page.goto('/coaches');
  await streamed(page);
  await expect(page.getByRole('heading', { level: 1, name: t.title, exact: true })).toBeVisible();
  // By the address, not the name: another run's coach may be listed too.
  const card = page.locator(`[data-testid="coach-card"][data-coach="${coach.slug}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(coach.name);
  await expect(card).toContainText('Падел');
  await expect(card.getByTestId('coach-card-price')).toContainText('40,00');
  await expectAxeClean(page);
  await shot(page, opts.shots, `public-${opts.tag}-1-list`);

  await card.click();
  await expect(page).toHaveURL(new RegExp(`/coaches/${coach.slug}$`));
  await streamed(page);
  await expect(
    page.getByRole('heading', { level: 1, name: coach.name, exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('coach-page-sports')).toContainText('Падел: нива 1–5');
  const where = page.getByTestId('coach-page-venue');
  await expect(where).toHaveCount(1);
  await expect(where).toContainText('40,00');
  await expect(where).toContainText('уроци по 60, 120 мин');
  await expect(where).toContainText('за група 60,00');
  await expect(page.getByText(t.page.courtNote)).toBeVisible();
  // Structured data is in the HTML the server sent.
  const ld = await page.locator('script[type="application/ld+json"]').first().textContent();
  expect(JSON.parse(ld ?? '{}')).toMatchObject({ '@type': 'Person', name: coach.name });
  await expectAxeClean(page);
  await shot(page, opts.shots, `public-${opts.tag}-2-coach`);

  // From the coach to the venue they teach at.
  await where.getByRole('link', { name: venue.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/venues/${venue.publicSlug}$`));
}
