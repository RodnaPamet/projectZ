import { expect, type Browser, type Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { signIn, testClientIp } from '../fixtures';
import { prisma } from './create-isolated-tenant';
import type { E2EPlayer } from './create-player';
import type { PlayedClub } from './seed-my-bookings';

/**
 * A booking's result in the browser (#575, #582): one player reports it, the
 * other side confirms or disputes it, and a dispute goes to the club's desk.
 * The ranking module is on for the run (`playwright.config.ts`).
 */

const r = bg.myBookings.result;
const results = bg.results;
const admin = bg.admin.results;

/** `userId` plays the club's completed booking too, as an added player. */
export async function addToCompleted(club: PlayedClub, userId: string): Promise<void> {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.bookingParticipant.create({
      data: { tenantId: club.tenantId, bookingId: club.completedId, userId, position: 2 },
    });
  });
}

/** A second browser, signed in as `who`, at the spec's width. */
export async function browserFor(
  browser: Browser,
  who: E2EPlayer,
  viewport: { width: number; height: number } = { width: 1280, height: 900 },
): Promise<Page> {
  const context = await browser.newContext({
    locale: 'bg-BG',
    viewport,
    extraHTTPHeaders: { 'x-forwarded-for': testClientIp() },
  });
  const page = await context.newPage();
  await signIn(page, who);
  return page;
}

/** The booker reports 6:4 6:3 for their side, the players as booked. */
export async function report(page: Page, bookingId: string): Promise<void> {
  await page.goto(`/me/bookings/${bookingId}`);
  const section = page.getByTestId('booking-result');
  await expect(section).toContainText(r.report);
  await page.getByTestId('booking-result-report').click();
  await expect(page.getByTestId('result-editor-player')).toHaveCount(2);
  for (const [cell, value] of [
    ['0-0', '6'],
    ['0-1', '4'],
    ['1-0', '6'],
    ['1-1', '3'],
  ] as const) {
    await page.getByTestId(`result-editor-cell-${cell}`).fill(value);
  }
  await page.getByTestId('result-editor-submit').click();
  await expect(page.getByTestId('booking-result-status')).toHaveText(results.status.REPORTED);
  await expect(page.getByTestId('result-summary')).toContainText('6');
}

/** The other side confirms; it counts, and the booker's profile shows the match. */
export async function confirmAndSeeRating(
  booker: Page,
  other: Page,
  bookingId: string,
): Promise<void> {
  await other.goto(`/me/bookings/${bookingId}`);
  await other.getByTestId('booking-result-confirm').click();
  await expect(other.getByTestId('booking-result-status')).toHaveText(results.status.CONFIRMED);

  await booker.goto('/me/profile');
  const padel = booker.getByTestId('profile-rating-PADEL');
  await expect(padel).toBeVisible();
  await expect(padel).toContainText('1 мач');
}

/** The other side disputes it with a note; the club's desk confirms it; both see it decided. */
export async function disputeAndDecide(other: Page, desk: Page, club: PlayedClub): Promise<void> {
  await other.goto(`/me/bookings/${club.completedId}`);
  await other.getByTestId('booking-result-reject').click();
  await other.getByLabel(r.rejectNote).fill('Вторият сет беше 3:6');
  await other.getByTestId('booking-result-reject-send').click();
  await expect(other.getByText(r.withClub)).toBeVisible();

  await desk.goto(`/t/${club.slug}/admin/results`);
  // Visible only: under the reveal throttle a streamed page can sit in a
  // hidden copy beside the shown one (see club-fee-journey.ts).
  const waiting = desk.getByTestId('club-results-waiting').filter({ visible: true });
  await expect(waiting.getByTestId('club-result-note')).toContainText('Вторият сет беше 3:6');
  await waiting.getByTestId('club-result-confirm').click();
  await expect(desk.getByTestId('club-results-none-waiting').filter({ visible: true })).toHaveText(
    admin.noneWaiting,
  );

  await other.goto(`/me/bookings/${club.completedId}`);
  await expect(other.getByTestId('booking-result-status')).toHaveText(results.status.DECIDED);
}
