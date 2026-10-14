import type { Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { shortName } from '../../../src/lib/coaches/reviews';
import { expect } from '../fixtures';
import { expectAxeClean } from './booking-detail-journey';
import { prisma } from './create-isolated-tenant';
import { settleAnimations } from './settle-animations';

/**
 * Reviewing a coach (#551; owner decisions 24–27), as the desktop and the
 * phone specs both run it: a player rates the coach of a lesson that is over,
 * from «Моите резервации»; the review is on the coach's page with the rating,
 * the author as first name and initial; another reader reports it and the
 * case is in the platform's queue; the author deletes it.
 */

const mb = bg.myBookings;
const cr = bg.coaches.reviews;
const rp = bg.messaging.report;

/**
 * The reviews section as the reader sees it. While a streamed stage is still
 * arriving, React can hold a copy in a hidden container; the region is only
 * the one on screen, and there must be exactly one.
 */
async function reviewsSection(page: Page) {
  await expect(page.getByTestId('coach-reviews').filter({ visible: true })).toHaveCount(1);
  return page.getByRole('region', { name: cr.title });
}

const shot = async (page: Page, dir: string | undefined, name: string) => {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
};

/** The lesson is over: as the completion sweep leaves it. */
export async function completeLesson(bookingId: string): Promise<void> {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.booking.update({ where: { id: bookingId }, data: { status: 'COMPLETED' } });
  });
}

/** From the past tab, the lesson's row: «Оцени треньора», five stars, a few words. */
export async function playerRatesTheCoach(
  page: Page,
  input: { bookingId: string; text: string },
  opts: { shots?: string; tag: string },
) {
  await page.goto('/me/bookings?tab=past');
  const row = page
    .getByRole('listitem')
    .filter({ has: page.locator(`a[href="/me/bookings/${input.bookingId}"]`) });
  await row.getByRole('button', { name: mb.review.coach.rate }).click();
  await expect(row.getByText(mb.review.coach.ratingLabel)).toBeVisible();
  await row.getByRole('radio').nth(4).check();
  await row.getByLabel(mb.review.bodyLabel).fill(input.text);
  await expectAxeClean(page);
  await shot(page, opts.shots, `coach-review-form-${opts.tag}`);
  const posted = page.waitForResponse(
    (r) => r.url().endsWith('/coach-review') && r.request().method() === 'POST',
  );
  await row.getByRole('button', { name: mb.review.submit }).click();
  // At once, before the server answers; then as stored: no classifier key
  // in these runs, so a text waits for a moderator.
  await expect(row.getByTestId('booking-card-coach-review')).toContainText(
    mb.review.coach.yours.replace('{rating}', '5'),
  );
  expect((await posted).status()).toBe(201);
  await expect(row.getByTestId('booking-card-coach-review')).toContainText(
    mb.review.status.PENDING_REVIEW,
  );
}

/**
 * The classifier is not configured in these runs, so a text waits for a
 * moderator; this is the moderator's yes, as the queue would record it.
 */
export async function moderatorPublishes(coachUserId: string): Promise<void> {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    const review = await tx.coachReview.findFirstOrThrow({
      where: { coachUserId },
      select: { id: true },
    });
    await tx.coachReview.update({ where: { id: review.id }, data: { status: 'PUBLISHED' } });
    await tx.moderationCase.updateMany({
      where: { subjectType: 'COACH_REVIEW', subjectId: review.id, status: 'OPEN' },
      data: { status: 'APPROVED', resolvedAt: new Date(), resolutionNote: 'e2e' },
    });
  });
}

/** On the coach's page: the rating, the author as «E2E P.», the text. */
export async function theReviewIsOnTheCoachPage(
  page: Page,
  input: { slug: string; author: string; text: string },
  opts: { shots?: string; tag: string },
) {
  await page.goto(`/coaches/${input.slug}`);
  const section = await reviewsSection(page);
  await expect(section.getByTestId('coach-reviews-rating')).toHaveText('4,1 ★ · 1 отзив');
  const review = section.getByTestId('coach-review');
  await expect(review).toHaveCount(1);
  await expect(review).toContainText(shortName(input.author)!);
  await expect(review).toContainText(input.text);
  await expect(review.getByLabel('5 от 5 звезди')).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await expectAxeClean(page);
  await shot(page, opts.shots, `coach-reviews-${opts.tag}`);
}

/** Another reader reports it; one case for the review is open in the queue. */
export async function aReaderReportsIt(
  page: Page,
  input: { slug: string; coachUserId: string },
  opts: { shots?: string; tag: string },
) {
  await page.goto(`/coaches/${input.slug}`);
  const section = await reviewsSection(page);
  await section.getByTestId('coach-review-report').click();
  const dialog = page.getByRole('dialog');
  // The vendored modal names itself twice (its title and the drawer's).
  await expect(dialog.getByRole('heading', { name: rp.titleReview }).first()).toBeVisible();
  await dialog.getByRole('radio', { name: rp.reason.abuse }).check();
  await settleAnimations(dialog);
  await expectAxeClean(page);
  await shot(page, opts.shots, `coach-review-report-${opts.tag}`);
  await dialog.getByRole('button', { name: rp.submit }).click();
  await expect(dialog.getByText(rp.sent)).toBeVisible();
  const open = await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    const review = await tx.coachReview.findFirstOrThrow({
      where: { coachUserId: input.coachUserId },
      select: { id: true },
    });
    return tx.moderationCase.findMany({
      where: { subjectType: 'COACH_REVIEW', subjectId: review.id, status: 'OPEN' },
      select: { reason: true },
    });
  });
  expect(open).toEqual([{ reason: 'user_report' }]);
}

/** The author deletes it from the coach's page; it is gone, and so is the number. */
export async function theAuthorDeletesIt(page: Page, slug: string) {
  await page.goto(`/coaches/${slug}`);
  const section = await reviewsSection(page);
  await section.getByTestId('coach-review-delete').click();
  await page.getByRole('button', { name: cr.deleteYes }).click();
  await expect(section.getByTestId('coach-reviews-none')).toBeVisible();
  await expect(section.getByTestId('coach-reviews-rating')).toHaveCount(0);
}
