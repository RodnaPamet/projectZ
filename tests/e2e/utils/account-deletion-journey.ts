import { readFile } from 'node:fs/promises';

import { expect, type Locator, type Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { expectAxeClean, streamed } from './booking-detail-journey';
import { prisma } from './create-isolated-tenant';

/**
 * "Изтриване на профила" and "Изтегли моите данни" on /me/profile (#370),
 * shared by the 1280 px spec and its 393 px twin.
 *
 * Straight to Prisma for the seed, as the other journeys: a club with one
 * played booking, one in three days (the player may still cancel it) and one
 * in two hours (inside the club's 24-hour cutoff: they wait until it is over).
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface DeletionClub {
  tenantId: string;
  venueName: string;
  laterId: string;
  soonId: string;
}

export async function seedBlockingBookings(userId: string): Promise<DeletionClub> {
  const tag = Math.random().toString(36).slice(2, 10);
  const venueName = `E2E Изтриване ${tag}`;
  return prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    const org = await tx.venueOrg.create({
      data: {
        name: `E2E del ${tag}`,
        slug: `e2e-del-${tag}`,
        contactEmail: `e2e-del-${tag}@playerz.test`,
        city: 'Sofia',
        tenantTestRun: `e2e-del-${tag}`,
      },
    });
    await tx.tenantMembership.create({
      data: { tenantId: org.id, userId, role: 'PLAYER', status: 'ACTIVE' },
    });
    const venue = await tx.venue.create({
      data: {
        tenantId: org.id,
        slug: `e2e-del-venue-${tag}`,
        name: venueName,
        addressLine: '1 Court St',
        city: 'Sofia',
        lat: 42.6977,
        lng: 23.3219,
        email: `e2e-del-${tag}@playerz.test`,
        timezone: 'Europe/Sofia',
      },
    });
    const court = await tx.resource.create({
      data: {
        tenantId: org.id,
        venueId: venue.id,
        name: 'Корт 1',
        sport: 'PADEL',
        surface: 'HARD',
        basePriceCents: 2400,
      },
    });
    const book = (start: Date, status: 'COMPLETED' | 'CONFIRMED', key: string) =>
      tx.booking.create({
        data: {
          tenantId: org.id,
          resourceId: court.id,
          startTs: start,
          endTs: new Date(start.getTime() + HOUR),
          bookedByUserId: userId,
          status,
          totalCents: 2400,
          idempotencyKey: `e2e-del-${key}-${tag}`,
        },
      });
    const hour = (ms: number) => new Date(Math.ceil((Date.now() + ms) / HOUR) * HOUR);
    await book(hour(-2 * DAY), 'COMPLETED', 'played');
    const later = await book(hour(3 * DAY), 'CONFIRMED', 'later');
    const soon = await book(hour(2 * HOUR), 'CONFIRMED', 'soon');
    return { tenantId: org.id, venueName, laterId: later.id, soonId: soon.id };
  });
}

export async function destroyDeletionClub(club: DeletionClub): Promise<void> {
  try {
    await prisma().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
      await tx.booking.deleteMany({ where: { tenantId: club.tenantId } });
      await tx.venue.deleteMany({ where: { tenantId: club.tenantId } });
      await tx.venueOrg.deleteMany({ where: { id: club.tenantId } });
    });
  } catch (err) {
    console.warn(`e2e: could not delete club ${club.tenantId}: ${(err as Error).message}`);
  }
}

async function openProfile(page: Page) {
  await page.goto('/me/profile');
  await streamed(page);
}

/** Upcoming bookings: listed, each linked, the button held back; and the export downloads. */
export async function blockedAndExport(
  page: Page,
  club: DeletionClub,
  opts: { shot?: string } = {},
) {
  await openProfile(page);
  const section = page.getByTestId('profile-delete-blocked');
  await expect(section).toContainText(bg.profile.delete.blocked.title);
  const items = page.getByTestId('profile-delete-booking');
  await expect(items).toHaveCount(2);
  // Soonest first: the one inside the cutoff waits, the later one is cancelled.
  await expect(items.nth(0)).toHaveAttribute('href', `/me/bookings/${club.soonId}`);
  await expect(items.nth(0)).toHaveAttribute('data-cure', 'wait');
  await expect(items.nth(1)).toHaveAttribute('href', `/me/bookings/${club.laterId}`);
  await expect(items.nth(1)).toHaveAttribute('data-cure', 'cancel');
  await expect(items.nth(0)).toContainText(club.venueName);
  await expect(page.getByTestId('profile-delete-button')).toBeDisabled();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('profile-export').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^playerz-data-\d{4}-\d{2}-\d{2}\.json$/);
  const file = JSON.parse(await readFile((await download.path())!, 'utf8')) as {
    profile: { accountKind: string };
    bookings: { asBooker: Array<{ venue: string }> };
  };
  expect(file.profile.accountKind).toBe('PLAYER');
  expect(file.bookings.asBooker).toHaveLength(3);
  expect(file.bookings.asBooker[0]!.venue).toBe(club.venueName);

  await expectAxeClean(page);
  if (opts.shot) {
    // The export and the top of the section, then the whole list.
    await capture(page, page.getByTestId('profile-export-row'), opts.shot);
    await capture(page, section, opts.shot.replace('-blocked-', '-blocked-list-'));
  }
}

/**
 * A screenshot for the PR that shows `target` where a person sees it: scrolled
 * to the top of the frame, just under its top bar, and the viewport taken with
 * the frame's bars around it. Not a full-page capture: a phone's bars are
 * fixed, and a full-page capture draws them in the middle of the page.
 */
async function capture(page: Page, target: Locator, path: string) {
  await target.evaluate((el) => {
    el.scrollIntoView({ block: 'start' });
    // From md the shell scrolls its own frame; on a phone the document does.
    let box = el.parentElement;
    while (box && box !== document.body && box.scrollHeight <= box.clientHeight) {
      box = box.parentElement;
    }
    const scroller = box && box !== document.body ? box : document.scrollingElement;
    scroller?.scrollBy(0, -88);
  });
  await page.screenshot({ path });
}

/** No upcoming booking: the typed confirmation, the deletion, and signed out on the home page. */
export async function deleteAccountFromProfile(
  page: Page,
  opts: { shots?: { allowed: string; dialog: string; landing: string } } = {},
) {
  await openProfile(page);
  const section = page.getByTestId('profile-delete-allowed');
  await expect(section).toContainText(bg.profile.delete.intro);
  await expect(page.getByTestId('profile-export-row')).toBeVisible();
  if (opts.shots) await capture(page, page.getByTestId('profile-export-row'), opts.shots.allowed);

  await page.getByTestId('profile-delete-button').click();
  const input = page.getByTestId('delete-account-confirm-input');
  const confirm = page.getByTestId('delete-account-confirm');
  await expect(input).toBeVisible();
  await expect(confirm).toBeDisabled();
  await input.fill('изтри');
  await expect(confirm).toBeDisabled();
  await input.fill(bg.profile.delete.dialog.word);
  await expect(confirm).toBeEnabled();
  await expectAxeClean(page);
  if (opts.shots) await page.screenshot({ path: opts.shots.dialog });

  const deleted = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/v1/me' && r.request().method() === 'DELETE',
  );
  await confirm.click();
  expect((await deleted).status()).toBe(204);

  await page.waitForURL((url) => url.pathname === '/' && url.search === '?account=deleted');
  // The landing streams in under its loading shell: wait for the swap, or the
  // hidden streamed copy is a second match.
  await streamed(page);
  await expect(page.getByTestId('landing-account-deleted')).toHaveText(bg.landing.accountDeleted);
  if (opts.shots) await page.screenshot({ path: opts.shots.landing });

  // Signed out, everywhere next-auth or the app asks.
  const session = await page.request.get('/api/auth/session');
  expect(await session.json()).toEqual({});
  await page.goto('/me/profile');
  await expect(page).toHaveURL(/\/login/);
}

/** A club account: no button, the way to ask instead. */
export async function clubProfile(page: Page, opts: { shot?: string } = {}) {
  await openProfile(page);
  const box = page.getByTestId('profile-delete-club');
  await expect(box).toContainText(bg.profile.delete.club.body);
  await expect(page.getByTestId('profile-delete-contact')).toHaveAttribute('href', '/#clubs');
  await expect(page.getByTestId('profile-delete-button')).toHaveCount(0);
  // The export is every kind's.
  await expect(page.getByTestId('profile-export-row')).toBeVisible();
  if (opts.shot) await capture(page, page.getByTestId('profile-export-row'), opts.shot);
}
