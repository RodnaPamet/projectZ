import type { Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { expect } from '../fixtures';
import { expectAxeClean } from './booking-detail-journey';
import type { ClubVenue } from './club-page-journey';
import type { IsolatedTenant } from './create-isolated-tenant';
import { settleAnimations } from './settle-animations';
import { streamed } from './streamed';
import { expectNoDrift } from './venue-booking-journey';

/**
 * Booking a lesson (#548), as the desktop and the phone spec both run it: a
 * player on the coach's page picks tomorrow and a time, confirms, and finds
 * the lesson in Резервации; the club finds it in its diary; the coach in
 * «Уроци».
 */

const l = bg.coaches.lesson;
const v = bg.venue;

const shot = async (page: Page, dir: string | undefined, name: string) => {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
};

export interface LessonCoach {
  slug: string;
  name: string;
  linkId: string;
}

/** What the player booked, for the other two to look for. */
export interface BookedLessonSeen {
  bookingId: string;
  /** "09:00", by the venue's clock. */
  start: string;
  /** `YYYY-MM-DD` at the venue. */
  day: string;
}

/**
 * The player, signed in, on the coach's page as a venue page links to it:
 * tomorrow, the first time on offer, the sheet with both prices, confirm.
 */
export async function playerBooksALesson(
  page: Page,
  coach: LessonCoach,
  venue: ClubVenue,
  opts: { shots?: string; tag: string },
): Promise<BookedLessonSeen> {
  await page.goto(`/coaches/${coach.slug}?at=${coach.linkId}`);
  await streamed(page);
  const section = page.getByTestId('lesson-booking');
  await expect(section.getByRole('heading', { level: 2, name: l.title })).toBeVisible();
  await expect(section.getByTestId('lesson-venue')).toContainText(venue.name);

  // Tomorrow: today's times depend on the hour the test runs at. The day
  // chosen is in the address (the page mirrors it there), which is where this
  // reads it from: a response to wait for could as well be today's, still
  // being checked against the server.
  const dayInUrl = () => new URL(page.url()).searchParams.get('day');
  await expect.poll(dayInUrl).not.toBeNull();
  const today = dayInUrl();
  const tomorrow = section.getByRole('radio', { name: v.day.tomorrow });
  await tomorrow.click();
  await expect(tomorrow).toHaveAttribute('aria-checked', 'true');
  await expect.poll(dayInUrl).not.toBe(today);
  const day = dayInUrl()!;

  // The coach works from eight: the first lesson of the day, and of THAT day.
  const first = section.getByTestId('lesson-time').first();
  await expect(first).toBeVisible();
  await expect(first).toContainText(/^08:00 · 64\s€$/);
  await expect(first).toHaveAttribute('data-start', new RegExp(`^${day}T0[56]:00:00Z$`));
  await expect(section.getByTestId('lesson-price-note')).toContainText(/40\s€ за треньора/);
  await expectNoDrift(page);
  await expectAxeClean(page);
  await shot(page, opts.shots, `lesson-${opts.tag}-1-times`);

  await first.click();
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(section.getByTestId('lesson-pick')).toContainText('08:00');
  // The pick is in the address, so a reload keeps it.
  await expect(page).toHaveURL(/[?&]start=/);
  await section.getByTestId('lesson-book').click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('lesson-sheet')).toBeVisible();
  await settleAnimations(dialog);
  await expect(dialog).toContainText(coach.name);
  await expect(dialog).toContainText(venue.name);
  await expect(dialog).toContainText('Корт 1 · Падел');
  await expect(dialog).toContainText('08:00–09:00');
  const price = dialog.getByTestId('lesson-sheet-price');
  await expect(price).toContainText(/За треньора\s*40,00\s€/);
  await expect(price).toContainText(/За корта\s*24,00\s€/);
  await expect(dialog.getByTestId('lesson-sheet-total')).toHaveText(/^64,00\s€$/);
  await expect(dialog.getByText(l.sheet.payAtClub)).toBeVisible();
  await expectAxeClean(page);
  await shot(page, opts.shots, `lesson-${opts.tag}-2-sheet`);

  const post = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/v1/coaches/${coach.slug}/lessons` &&
      r.request().method() === 'POST',
  );
  await dialog.getByTestId('lesson-sheet-confirm').click();
  const res = await post;
  expect(res.status()).toBe(201);
  const booked = (await res.json()) as { data: { id: string; lesson: { totalCents: number } } };
  expect(booked.data.lesson.totalCents).toBe(6400);

  // Резервации: a lesson, with who teaches it and the whole price.
  await expect(page).toHaveURL(/\/me\/bookings$/);
  const card = page
    .getByRole('main')
    .locator('li')
    .filter({ has: page.locator(`a[href="/me/bookings/${booked.data.id}"]`) });
  await expect(card.getByTestId('booking-card-lesson')).toHaveText(`Урок с ${coach.name}`);
  await expect(card).toContainText(/64,00\s€/);
  await expect(card).toContainText(venue.name);
  await expectNoDrift(page);
  await shot(page, opts.shots, `lesson-${opts.tag}-3-my-bookings`);

  // Its own page: the coach, linked, and the price in its two parts.
  await card.getByTestId('booking-card-link').click();
  await expect(page).toHaveURL(new RegExp(`/me/bookings/${booked.data.id}$`));
  await streamed(page);
  const coachLink = page.getByTestId('booking-lesson-coach');
  await expect(coachLink).toHaveText(coach.name);
  await expect(coachLink).toHaveAttribute('href', `/coaches/${coach.slug}`);
  await expect(page.getByTestId('booking-lesson-total')).toHaveText(/^64,00\s€$/);
  await expect(page.getByTestId('booking-lesson-parts')).toHaveText(
    /^40,00\s€ за треньора \+ 24,00\s€ за корта$/,
  );
  await expectAxeClean(page);
  await shot(page, opts.shots, `lesson-${opts.tag}-4-booking`);

  return { bookingId: booked.data.id, start: '08:00', day };
}

/** The club's diary for that day: the lesson's block names the coach. */
export async function clubSeesTheLesson(
  page: Page,
  club: IsolatedTenant,
  coach: LessonCoach,
  seen: BookedLessonSeen,
  opts: { shots?: string; tag: string },
) {
  await page.goto(`/t/${club.tenantSlug}/admin/calendar?day=${seen.day}`);
  await streamed(page);
  const mark = page.locator('[data-booking-lesson]');
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveText(`урок с ${coach.name}`);
  const block = page.locator('[data-booking-status]').filter({ has: mark });
  await expect(block).toContainText('08:00–09:00');
  // What the desk collects: the court and the coach's fee.
  await expect(block).toContainText(/64,00\s€/);
  await expectNoDrift(page);
  await shot(page, opts.shots, `lesson-${opts.tag}-5-diary`);
}

/** The coach's own page: «Уроци» has it, with who booked. */
export async function coachSeesTheLesson(
  page: Page,
  venue: ClubVenue,
  playerName: string,
  seen: BookedLessonSeen,
  opts: { shots?: string; tag: string },
) {
  await page.goto('/me/coach');
  await streamed(page);
  const row = page.locator(`[data-testid="coach-lesson"][data-booking="${seen.bookingId}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('08:00–09:00');
  await expect(row).toContainText(`${venue.name} · Корт 1 · Падел`);
  await expect(row.getByTestId('coach-lesson-player')).toHaveText(`Играч: ${playerName}`);
  await expect(row).toContainText(/Вашият хонорар: 40,00\s€/);
  // The court's price is the club's: not in the coach's list.
  await expect(row).not.toContainText('24,00');
  await row.scrollIntoViewIfNeeded();
  await expectNoDrift(page);
  await expectAxeClean(page);
  await shot(page, opts.shots, `lesson-${opts.tag}-6-coach-lessons`);
}

/** Somebody else, signed out, looking at the same day: that time is gone. */
export async function theTimeIsGone(page: Page, coach: LessonCoach, seen: BookedLessonSeen) {
  await page.goto(`/coaches/${coach.slug}?at=${coach.linkId}&day=${seen.day}`);
  await streamed(page);
  const section = page.getByTestId('lesson-booking');
  await expect(section.getByTestId('lesson-time').first()).toBeVisible();
  await expect(section.getByTestId('lesson-time').first()).toContainText(/^09:00/);
  await expect(section.getByRole('button', { name: /^08:00/ })).toHaveCount(0);
}
