import { expect, type Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { prisma } from './create-isolated-tenant';

/**
 * A club tournament in the browser (#579, #580, #582): the desk creates and
 * opens it, two players enter, the desk confirms them, makes the draw and puts
 * the final on a court; the players report and confirm its result through the
 * booking, and the tournament is over.
 */

const DAY = 86_400_000;

/**
 * The visible one: under the reveal throttle a streamed page can sit in a
 * hidden copy beside the shown one (see club-fee-journey.ts).
 */
const shown = (page: Page, testId: string) => page.getByTestId(testId).filter({ visible: true });

/** A `datetime-local` value `days` from now at `hour`, in the browser's zone. */
function localAt(days: number, hour: number): string {
  const d = new Date(Date.now() + days * DAY);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
}

/** The desk creates a two-player knockout and opens sign-up; its id. */
export async function createAndOpen(desk: Page, slug: string, name: string): Promise<string> {
  await desk.goto(`/t/${slug}/admin/tournaments`);
  await shown(desk, 'tournament-new').click();
  await shown(desk, 'tournament-form-name').fill(name);
  await shown(desk, 'tournament-form-starts').fill(localAt(3, 10));
  await shown(desk, 'tournament-form-draw').fill('2');
  await shown(desk, 'tournament-form-submit').click();
  await desk.waitForURL(/\/admin\/tournaments\/[^/?#]+$/);
  const id = new URL(desk.url()).pathname.split('/').pop()!;
  await shown(desk, 'admin-tournament-open').click();
  await expect(shown(desk, 'admin-tournament-status')).toHaveText(
    bg.tournaments.status.REGISTRATION,
  );
  return id;
}

/** A player enters on the tournament's page. */
export async function enter(page: Page, id: string): Promise<void> {
  await page.goto(`/tournaments/${id}`);
  await shown(page, 'tournament-enter').click();
  await expect(shown(page, 'tournament-entry-status')).toBeVisible();
}

/** The desk confirms both entries, makes the draw and puts the final on the court. */
export async function confirmDrawAndSchedule(desk: Page, slug: string, id: string): Promise<void> {
  await desk.goto(`/t/${slug}/admin/tournaments/${id}`);
  const confirm = shown(desk, 'admin-tournament-confirm');
  await expect(confirm).toHaveCount(2);
  await confirm.first().click();
  await expect(confirm).toHaveCount(1);
  await confirm.first().click();
  await expect(confirm).toHaveCount(0);

  await shown(desk, 'admin-draw-make').click();
  await shown(desk, 'admin-draw-confirm').click();
  await expect(shown(desk, 'draw-match')).toHaveCount(1);

  await shown(desk, 'admin-draw-schedule').click();
  await shown(desk, 'admin-draw-schedule-at').fill(localAt(2, 10));
  await shown(desk, 'admin-draw-schedule-save').click();
  await expect(shown(desk, 'draw-match-scheduled')).toBeVisible();
}

/** The final is played: its booking completes, as the end-of-day job would mark it. */
export async function playTheFinal(tournamentId: string): Promise<void> {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    const m = await tx.tournamentMatch.findFirstOrThrow({
      where: { tournamentId, bookingId: { not: null } },
      select: { bookingId: true },
    });
    await tx.booking.update({ where: { id: m.bookingId! }, data: { status: 'COMPLETED' } });
  });
}

/**
 * One finalist follows the draw to the match's booking and reports 6:4 6:3,
 * the sides as the draw set them; the other confirms; the tournament is over.
 */
export async function reportAndConfirmTheFinal(
  reporter: Page,
  other: Page,
  id: string,
): Promise<void> {
  await reporter.goto(`/tournaments/${id}`);
  await shown(reporter, 'draw-match-booking').click();
  await reporter.waitForURL(/\/me\/bookings\/[^/?#]+$/);
  const bookingPath = new URL(reporter.url()).pathname;

  await shown(reporter, 'booking-result-report').click();
  await expect(shown(reporter, 'result-editor-fixed')).toBeVisible();
  for (const [cell, value] of [
    ['0-0', '6'],
    ['0-1', '4'],
    ['1-0', '6'],
    ['1-1', '3'],
  ] as const) {
    await shown(reporter, `result-editor-cell-${cell}`).fill(value);
  }
  await shown(reporter, 'result-editor-submit').click();
  await expect(shown(reporter, 'booking-result-status')).toHaveText(bg.results.status.REPORTED);

  await other.goto(bookingPath);
  await shown(other, 'booking-result-confirm').click();
  await expect(shown(other, 'booking-result-status')).toHaveText(bg.results.status.CONFIRMED);

  await other.goto(`/tournaments/${id}`);
  await expect(shown(other, 'tournament-status')).toHaveText(bg.tournaments.status.COMPLETE);
  await expect(shown(other, 'draw-match')).toContainText('6');
}

/** The club's tournaments, before the club itself goes. */
export async function destroyTournaments(tenantId: string): Promise<void> {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.tournamentMatch.deleteMany({ where: { tenantId } });
    await tx.tournamentEntry.deleteMany({ where: { tenantId } });
    await tx.tournament.deleteMany({ where: { tenantId } });
  });
}
