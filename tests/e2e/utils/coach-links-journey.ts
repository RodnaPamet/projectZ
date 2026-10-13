import { randomUUID } from 'node:crypto';

import type { Browser, Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { expect, signIn, testClientIp } from '../fixtures';
import { expectAxeClean } from './booking-detail-journey';
import type { ClubVenue } from './club-page-journey';
import { prisma, type IsolatedTenant } from './create-isolated-tenant';
import { streamed } from './streamed';

/**
 * A coach and a club's venue (#546), as the desktop and the phone spec both
 * run it: an approved coach asks a venue; the club's owner accepts on the
 * club's coaches page; the coach sets a price, a lesson length and hours; the
 * club sees them; the coach marks a day off.
 */

const t = bg.coachVenues;
const a = bg.admin.coaches;

const shot = async (page: Page, dir: string | undefined, name: string) => {
  if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
};

/** Give the coach a profile the platform approved, as the platform does it (P72). */
export async function approveCoach(coachId: string, adminId: string) {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.$executeRawUnsafe(`SELECT set_config('app.platform_admin_id', $1, true)`, adminId);
    await tx.coachProfile.create({
      data: {
        userId: coachId,
        slug: `e2e-coach-${randomUUID().slice(0, 8)}`,
        bio: 'Треньор по падел и тенис от 2010 г. Работя с начинаещи и с напреднали.',
        qualifications: 'Лиценз ББФТ, ниво 2',
        status: 'APPROVED',
        submittedAt: new Date(),
        decidedAt: new Date(),
        decidedByUserId: adminId,
        sports: { create: [{ sport: 'PADEL', levelMin: 1, levelMax: 5 }] },
      },
    });
  });
}

/** The club's owner, in a browser of their own. */
export async function signInClubOwner(
  browser: Browser,
  club: IsolatedTenant,
  contextOptions: Parameters<Browser['newContext']>[0] = {},
) {
  const context = await browser.newContext({
    ...contextOptions,
    extraHTTPHeaders: { 'x-forwarded-for': testClientIp() },
  });
  const page = await context.newPage();
  await signIn(page, club);
  return { page, close: () => context.close() };
}

const row = (page: Page, venue: ClubVenue) =>
  page.locator(`[data-testid="coach-venue"][data-venue="${venue.venueId}"]`);

/** The coach finds the venue by name and asks. */
export async function coachAsks(
  page: Page,
  venue: ClubVenue,
  opts: { shots?: string; tag: string },
) {
  await page.goto('/me/coach');
  await streamed(page);
  await expect(page.getByTestId('coach-venues')).toContainText(t.none);
  await page.getByTestId('coach-venue-add').click();
  await page.getByTestId('coach-venue-search').fill(venue.name);
  const ask = page.locator(`[data-testid="coach-venue-ask"][data-venue="${venue.venueId}"]`);
  await expect(ask).toBeVisible();
  await expectAxeClean(page);
  await shot(page, opts.shots, `links-${opts.tag}-1-search`);
  await ask.click();

  await expect(row(page, venue)).toHaveAttribute('data-status', 'REQUESTED');
  await expect(row(page, venue)).toContainText(t.status.REQUESTED);
}

/** The club's owner sees the request with the coach's card, and accepts. */
export async function clubAccepts(
  page: Page,
  club: IsolatedTenant,
  coachLinkVenue: ClubVenue,
  coachName: string,
  opts: { shots?: string; tag: string },
) {
  await page.goto(`/t/${club.tenantSlug}/admin/coaches`);
  await streamed(page);
  await expect(page.getByRole('heading', { level: 1, name: a.title, exact: true })).toBeVisible();
  const request = page.getByTestId('club-coach-requests').getByTestId('club-coach-card');
  await expect(request).toHaveCount(1);
  await expect(request).toContainText(coachName);
  await expect(request).toContainText(coachLinkVenue.name);
  await expect(request).toContainText('Падел: нива 1–5');
  await expect(request).toContainText('Лиценз ББФТ, ниво 2');
  await expectAxeClean(page);
  await shot(page, opts.shots, `links-${opts.tag}-2-request`);

  await request.getByTestId('club-coach-accept').click();
  const active = page.getByTestId('club-coaches-active').getByTestId('club-coach-card');
  await expect(active).toHaveCount(1);
  await expect(active).toContainText(coachName);
  await expect(page.getByTestId('club-coach-requests')).toContainText(a.requests.none);
  // Nothing set yet: the club is told lessons cannot be booked with them.
  await expect(active.getByTestId('club-coach-missing')).toBeVisible();
}

/** The coach sets a price, a length and Monday mornings, and marks a day off. */
export async function coachSetsTerms(
  page: Page,
  venue: ClubVenue,
  opts: { shots?: string; tag: string },
) {
  await page.reload();
  await streamed(page);
  await expect(row(page, venue)).toHaveAttribute('data-status', 'ACTIVE');
  await expect(row(page, venue).getByTestId('coach-venue-missing')).toBeVisible();

  await row(page, venue).getByTestId('coach-venue-terms').click();
  const sheet = page.getByTestId('coach-terms');
  await sheet.getByTestId('coach-terms-hourly').fill('40');
  // The seeded court is booked for one or two hours: those are the choices.
  await expect(sheet.getByRole('checkbox')).toHaveCount(2);
  await sheet.getByRole('checkbox', { name: '60 мин' }).check();
  await sheet.getByTestId('coach-hours-add-1').click();
  await expect(sheet.getByLabel('Пн, интервал 1: от')).toHaveValue('09:00');
  await expectAxeClean(page);
  await shot(page, opts.shots, `links-${opts.tag}-3-terms`);
  await sheet.getByTestId('coach-terms-save').click();

  await expect(sheet).toHaveCount(0);
  await expect(row(page, venue).getByTestId('coach-venue-summary')).toContainText('40,00');
  await expect(row(page, venue).getByTestId('coach-venue-missing')).toHaveCount(0);

  // A day off, a week from now.
  const day = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  await page.getByTestId('coach-time-off-start').fill(day);
  await page.getByTestId('coach-time-off-add').click();
  await expect(page.getByTestId('coach-time-off-item')).toHaveCount(1);
  await expectAxeClean(page);
  await shot(page, opts.shots, `links-${opts.tag}-4-teaching`);
}

/** The club sees what the coach set, and can end it. */
export async function clubSeesTerms(page: Page, opts: { shots?: string; tag: string }) {
  await page.reload();
  await streamed(page);
  const active = page.getByTestId('club-coaches-active').getByTestId('club-coach-card');
  await expect(active.getByTestId('club-coach-rates')).toContainText('40,00');
  await expect(active.getByTestId('club-coach-hours')).toHaveText('Пн 09:00–12:00');
  await expect(active.getByTestId('club-coach-missing')).toHaveCount(0);
  await shot(page, opts.shots, `links-${opts.tag}-5-club`);

  await active.getByTestId('club-coach-end').click();
  await page.getByRole('dialog').getByRole('button', { name: a.action.end, exact: true }).click();
  await expect(page.getByTestId('club-coaches-active').getByTestId('club-coach-card')).toHaveCount(
    0,
  );
}

/** A coach's rows are not tied to the account by a key: clear them. */
export async function clearCoachLinks(userId: string) {
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.coachTimeOff.deleteMany({ where: { userId } });
    await tx.coach.deleteMany({ where: { userId } });
    await tx.coachProfile.deleteMany({ where: { userId } });
  });
}
