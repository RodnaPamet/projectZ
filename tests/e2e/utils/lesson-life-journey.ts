import type { Browser, Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { expect, signIn, testClientIp } from '../fixtures';
import { expectAxeClean } from './booking-detail-journey';
import { recordShares } from './booking-players-journey';
import type { ClubVenue } from './club-page-journey';
import { prisma, type IsolatedTenant } from './create-isolated-tenant';
import type { E2EPlayer } from './create-player';
import type { LessonCoach } from './lesson-booking-journey';
import { settleAnimations } from './settle-animations';
import { streamed } from './streamed';
import { expectNoDrift } from './venue-booking-journey';

/**
 * Living with a lesson (#549), as the desktop and the phone specs both run
 * it: a second player joins by invitation and the lesson becomes a group
 * lesson; the coach sees who is coming and cancels; the coach marks a
 * no-show; the club's desk cancels a lesson from its diary.
 */

const mb = bg.myBookings;
const cl = bg.coachLessons;
const dp = bg.admin.calendar.players;

const shot = async (page: Page, dir: string | undefined, name: string) => {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
};

/** A lesson written as booking writes it, `minutesFromNow` away (negative: started). */
export async function seedLesson(input: {
  club: IsolatedTenant;
  venue: ClubVenue;
  coach: { userId: string; linkId: string };
  playerId: string;
  minutesFromNow: number;
}): Promise<{ bookingId: string; lessonId: string; day: string }> {
  return prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    const court = await tx.resource.findFirstOrThrow({
      where: { venueId: input.venue.venueId },
      select: { id: true },
    });
    await tx.tenantMembership.createMany({
      data: [
        { tenantId: input.club.tenantId, userId: input.playerId, role: 'PLAYER', status: 'ACTIVE' },
      ],
      skipDuplicates: true,
    });
    // On the quarter hour, so the diary draws it on a line.
    const QUARTER = 15 * 60_000;
    const startTs = new Date(
      Math.round((Date.now() + input.minutesFromNow * 60_000) / QUARTER) * QUARTER,
    );
    const endTs = new Date(startTs.getTime() + 60 * 60_000);
    const booking = await tx.booking.create({
      data: {
        tenantId: input.club.tenantId,
        resourceId: court.id,
        startTs,
        endTs,
        status: 'CONFIRMED',
        totalCents: 2400,
        idempotencyKey: `e2e-lesson-${startTs.getTime()}-${Math.random().toString(36).slice(2)}`,
        bookedByUserId: input.playerId,
      },
      select: { id: true },
    });
    const lesson = await tx.coachLesson.create({
      data: {
        tenantId: input.club.tenantId,
        bookingId: booking.id,
        coachId: input.coach.linkId,
        coachUserId: input.coach.userId,
        startTs,
        endTs,
        hourlyRateCents: 4000,
        groupRateCents: 6000,
        cancelCutoffHours: 12,
        coachFeeCents: 4000,
      },
      select: { id: true },
    });
    // The day at the club (Europe/Sofia), for the diary's address.
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(startTs);
    return { bookingId: booking.id, lessonId: lesson.id, day };
  });
}

/** The level a player says they play padel at. */
export async function setPadelLevel(userId: string, level: number): Promise<void> {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.playerSportLevel.upsert({
      where: { userId_sport: { userId, sport: 'PADEL' } },
      create: { userId, sport: 'PADEL', level },
      update: { level },
    });
  });
}

/**
 * The booker's lesson page says what a group costs before anybody is added;
 * a friend opens the invitation, is told it is a lesson and with whom, and
 * joins; the lesson is then a group lesson at the group fee.
 */
export async function aFriendJoinsTheLesson(
  page: Page,
  browser: Browser,
  input: { bookingId: string; coach: LessonCoach; friend: E2EPlayer },
  opts: { shots?: string; tag: string; contextOptions?: Parameters<Browser['newContext']>[0] },
) {
  await recordShares(page);
  await page.goto(`/me/bookings/${input.bookingId}`);
  await streamed(page);
  // Before anybody is added: what the coach is paid for a group, and the total.
  await expect(page.getByTestId('booking-lesson-group')).toHaveText(
    /^С втори играч урокът става групов: за треньора 60,00\s€ за цялата група, общо 84,00\s€ с корта\.$/,
  );
  await expect(page.getByTestId('booking-lesson-total')).toHaveText(/^64,00\s€$/);
  // A lesson is for the people its booker invites: nothing offers «Игри».
  await expect(page.getByTestId('booking-game-open')).toHaveCount(0);
  await expectAxeClean(page);
  await shot(page, opts.shots, `life-${opts.tag}-1-before`);

  await page.getByRole('button', { name: mb.players.invite }).click();
  const sheet = page.getByRole('dialog', { name: mb.players.sheetTitle });
  await sheet.getByRole('button', { name: mb.players.share }).click();
  const url = sheet.getByTestId('invite-url');
  await expect(url).toContainText('/invite/booking/');
  const path = new URL((await url.textContent())!.trim()).pathname;

  const context = await browser.newContext({
    ...opts.contextOptions,
    extraHTTPHeaders: { 'x-forwarded-for': testClientIp() },
  });
  const other = await context.newPage();
  try {
    await signIn(other, input.friend);
    await other.goto(path);
    await streamed(other);
    // Told it is a lesson, and with whom, before joining.
    const lesson = other.getByTestId('booking-invite-lesson');
    await expect(lesson).toContainText(bg.bookingInvite.lesson.label);
    await expect(lesson).toContainText(input.coach.name);
    await expect(other.getByText(bg.bookingInvite.lesson.payAtClub)).toBeVisible();
    await expectAxeClean(other);
    await shot(other, opts.shots, `life-${opts.tag}-2-invitation`);

    await other.getByRole('button', { name: bg.bookingInvite.join }).click();
    await expect(other).toHaveURL(new RegExp(`/me/bookings/${input.bookingId}$`));
    await streamed(other);
    await expect(other.getByTestId('booking-lesson-coach')).toHaveText(input.coach.name);
    await expect(other.getByTestId('booking-lesson-total')).toHaveText(/^84,00\s€$/);
  } finally {
    await context.close();
  }

  await page.keyboard.press('Escape');
  await page.reload();
  await streamed(page);
  await expect(page.getByTestId('booking-players')).toContainText(input.friend.name);
  await expect(page.getByTestId('booking-lesson-group')).toHaveText(
    /^Групов урок: за треньора 60,00\s€ за цялата група\.$/,
  );
  await expect(page.getByTestId('booking-lesson-total')).toHaveText(/^84,00\s€$/);
  await expect(page.getByTestId('booking-lesson-parts')).toHaveText(
    /^60,00\s€ за треньора \+ 24,00\s€ за корта$/,
  );
  await expectNoDrift(page);
  await shot(page, opts.shots, `life-${opts.tag}-3-group`);
}

const lessonRow = (page: Page, bookingId: string) =>
  page.locator(`[data-testid="coach-lesson"][data-booking="${bookingId}"]`);

/** The coach's «Уроци»: who is coming and at what level; then the coach cancels. */
export async function coachSeesWhoAndCancels(
  page: Page,
  input: { bookingId: string; playerName: string; level: number; players: number; fee: string },
  opts: { shots?: string; tag: string },
) {
  await page.goto('/me/coach');
  await streamed(page);
  const row = lessonRow(page, input.bookingId);
  // The ranking module is on for the run (#576): the coach sees the player's
  // rating, which starts at the level they declared and is provisional.
  const level = `${input.level},0 (неокончателно)`;
  await expect(row.getByTestId('coach-lesson-player')).toHaveText(
    input.players > 1
      ? `Играч: ${input.playerName} · ниво ${level} · ${input.players} играчи`
      : `Играч: ${input.playerName} · ниво ${level}`,
  );
  await expect(row).toContainText(new RegExp(`Вашият хонорар: ${input.fee}\\s€`));
  // Still ahead: it can be cancelled, and there is nothing to mark yet.
  await expect(row.getByTestId('coach-lesson-no-show')).toHaveCount(0);
  await expectAxeClean(page);
  await shot(page, opts.shots, `life-${opts.tag}-4-coach-sees`);

  await row.getByTestId('coach-lesson-cancel').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(cl.cancel.title);
  await expect(dialog).toContainText(
    'Кортът ще се освободи, а играчът ще получи известие и имейл.',
  );
  await settleAnimations(dialog);
  await expectAxeClean(page);
  await shot(page, opts.shots, `life-${opts.tag}-5-cancel-dialog`);
  const post = page.waitForResponse((r) =>
    /\/api\/v1\/me\/coach-lessons\/[^/]+\/cancel$/.test(new URL(r.url()).pathname),
  );
  await dialog.getByRole('button', { name: cl.cancel.yes }).click();
  expect((await post).status()).toBe(200);
  await expect(lessonRow(page, input.bookingId)).toHaveCount(0);

  // It is on «Минали» now, as cancelled.
  await page.getByRole('radio', { name: cl.tabs.past }).click();
  const past = lessonRow(page, input.bookingId);
  await expect(past).toHaveAttribute('data-status', 'CANCELLED');
  await expect(past).toContainText(mb.status.CANCELLED);
  await expect(past.getByTestId('coach-lesson-cancel')).toHaveCount(0);
  await shot(page, opts.shots, `life-${opts.tag}-6-coach-past`);
}

/** The player whose lesson the coach cancelled: the booking says so, and so does the bell. */
export async function playerSeesTheCoachCancelled(page: Page, bookingId: string) {
  await page.goto(`/me/bookings/${bookingId}`);
  await streamed(page);
  await expect(page.getByTestId('booking-status')).toHaveText(mb.status.CANCELLED);
  await page.getByTestId('header-notifications').click();
  await expect(
    page.getByTestId('notifications-panel').getByText('Треньорът отмени урока ви'),
  ).toBeVisible();
}

/** A lesson that has started: the coach records that the player did not come. */
export async function coachMarksANoShow(
  page: Page,
  input: { bookingId: string; playerName: string; clubName: string },
  opts: { shots?: string; tag: string },
) {
  await page.goto('/me/coach');
  await streamed(page);
  const row = lessonRow(page, input.bookingId);
  // Under way: no cancelling it now.
  await expect(row.getByTestId('coach-lesson-cancel')).toHaveCount(0);
  await row.getByTestId('coach-lesson-no-show').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(cl.noShow.title);
  await expect(dialog).toContainText(
    `${input.playerName} ще бъде отбелязан като неявил се в ${input.clubName}.`,
  );
  await settleAnimations(dialog);
  await shot(page, opts.shots, `life-${opts.tag}-7-no-show-dialog`);
  const post = page.waitForResponse((r) =>
    /\/api\/v1\/me\/coach-lessons\/[^/]+\/no-show$/.test(new URL(r.url()).pathname),
  );
  await dialog.getByRole('button', { name: cl.noShow.yes }).click();
  expect((await post).status()).toBe(200);
  await expect(lessonRow(page, input.bookingId)).toHaveCount(0);
  await page.getByRole('radio', { name: cl.tabs.past }).click();
  const past = lessonRow(page, input.bookingId);
  await expect(past).toHaveAttribute('data-status', 'NO_SHOW');
  await expect(past).toContainText(mb.status.NO_SHOW);
  await expect(past.getByTestId('coach-lesson-no-show')).toHaveCount(0);
}

/** The club's diary: the lesson's block opens a sheet that names the coach, and the desk cancels it. */
export async function deskCancelsTheLesson(
  page: Page,
  club: IsolatedTenant,
  input: { day: string; coachName: string },
  opts: { shots?: string; tag: string },
) {
  await page.goto(`/t/${club.tenantSlug}/admin/calendar?day=${input.day}`);
  await streamed(page);
  const mark = page.locator('[data-booking-lesson]');
  await expect(mark).toHaveText(`урок с ${input.coachName}`);
  await page.locator('[data-booking-status]').filter({ has: mark }).click();

  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('[data-diary-lesson]')).toHaveText(`Урок с ${input.coachName}`);
  await sheet.locator('[data-diary-lesson-cancel]').click();
  await expect(sheet.getByText(dp.cancelLesson.title)).toBeVisible();
  await expect(sheet.getByText(dp.cancelLesson.description)).toBeVisible();
  await settleAnimations(sheet);
  await expectAxeClean(page);
  await shot(page, opts.shots, `life-${opts.tag}-8-desk-cancel`);

  const post = page.waitForResponse((r) =>
    new RegExp(`/api/v1/t/${club.tenantSlug}/bookings/[^/]+/cancel$`).test(
      new URL(r.url()).pathname,
    ),
  );
  await sheet.locator('[data-diary-lesson-cancel-yes]').click();
  expect((await post).status()).toBe(200);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The court is free again in the diary.
  await expect(page.locator('[data-booking-lesson]')).toHaveCount(0);
  await expectNoDrift(page);
}
