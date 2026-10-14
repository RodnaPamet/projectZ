import { randomBytes } from 'node:crypto';

import type { Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { hashForLookup } from '../../../src/lib/security/encryption';
import { expect } from '../fixtures';
import { expectAxeClean } from './booking-detail-journey';
import type { ClubVenue } from './club-page-journey';
import { prisma, type IsolatedTenant } from './create-isolated-tenant';
import type { BookedLessonSeen } from './lesson-booking-journey';
import { streamed } from './streamed';

/**
 * The other two of #552's journeys: a coach joins a club the club's way (an
 * emailed invitation, accepted), and a player cancels their own lesson.
 */

const iv = bg.invite;
const mb = bg.myBookings;
const cv = bg.coachVenues;

const shot = async (page: Page, dir: string | undefined, name: string) => {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
};

/**
 * The invitation the club's form sends (`inviteCoachAction`): the token
 * exists only in the email, so here it is made as `createInvite` makes it,
 * with the server's key, and handed straight to the coach.
 */
export async function clubInvitesCoach(club: IsolatedTenant, email: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.invite.create({
      data: {
        tenantId: club.tenantId,
        email,
        role: 'COACH',
        tokenHash: hashForLookup(token),
        invitedById: club.userId,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });
  });
  return token;
}

/** The coach opens the link, signed in, accepts, and teaches at the club's venue at once. */
export async function coachAcceptsTheInvitation(
  page: Page,
  input: { token: string; club: IsolatedTenant; venue: ClubVenue },
  opts: { shots?: string; tag: string },
) {
  await page.goto(`/invite/${input.token}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    iv.title.replace('{club}', ''),
  );
  await expect(page.getByText(iv.asRole.replace('{role}', iv.role.COACH))).toBeVisible();
  await expectAxeClean(page);
  await shot(page, opts.shots, `invite-${opts.tag}-1-invitation`);
  await page.getByRole('button', { name: iv.accept }).click();

  await expect(page).toHaveURL(/\/me\/coach$/);
  await streamed(page);
  const row = page.locator(`[data-testid="coach-venue"][data-venue="${input.venue.venueId}"]`);
  // Both sides agreed (the club by inviting, the coach by accepting).
  await expect(row).toHaveAttribute('data-status', 'ACTIVE');
  await expect(row).toContainText(cv.status.ACTIVE);
  await shot(page, opts.shots, `invite-${opts.tag}-2-teaching`);
}

/**
 * Cutoffs short enough that tomorrow's lesson can still be cancelled whatever
 * hour the run starts at: the club's and the coach's are 24 hours by default,
 * and the stricter one rules (decision 7).
 */
export async function shortCutoffs(venueId: string, linkId: string): Promise<void> {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.venue.update({ where: { id: venueId }, data: { cancellationCutoffHours: 2 } });
    await tx.coach.update({ where: { id: linkId }, data: { cancelCutoffHours: 2 } });
  });
}

/** The player cancels their lesson from its page; the coach's «Уроци» no longer has it. */
export async function playerCancelsTheLesson(
  playerPage: Page,
  coachPage: Page,
  input: { seen: BookedLessonSeen; clubSlug: string },
  opts: { shots?: string; tag: string },
) {
  await playerPage.goto(`/me/bookings/${input.seen.bookingId}`);
  const cancel = playerPage.getByRole('button', { name: mb.detail.cancel });
  await expect(cancel).toBeEnabled();
  await cancel.click();
  const dialog = playerPage.getByRole('dialog', { name: mb.detail.confirm.title });
  await expect(dialog).toBeVisible();
  await shot(playerPage, opts.shots, `cancel-${opts.tag}-1-confirm`);
  const posted = playerPage.waitForResponse((r) =>
    r.url().endsWith(`/api/v1/t/${input.clubSlug}/bookings/${input.seen.bookingId}/cancel`),
  );
  await dialog.getByRole('button', { name: mb.detail.confirm.yes }).click();
  expect((await posted).status()).toBe(200);
  await expect(playerPage.getByTestId('booking-status')).toHaveText(mb.status.CANCELLED);

  await coachPage.goto('/me/coach');
  await streamed(coachPage);
  await expect(
    coachPage.locator(`[data-testid="coach-lesson"][data-booking="${input.seen.bookingId}"]`),
  ).toHaveCount(0);
}
