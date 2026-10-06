import bcrypt from 'bcryptjs';
import { expect, type Browser, type Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { signIn } from '../fixtures';
import { streamed } from './booking-detail-journey';
import { E2E_PASSWORD, prisma } from './create-isolated-tenant';
import { destroyPlayer, type E2EPlayer } from './create-player';

/**
 * Players on a booking (#358) and the first-sign-in question (#360), shared by
 * the 1280 px specs and their 393 px twins.
 */

const mb = bg.myBookings;

/** A second account: a PLAYER with a name, or a brand-new one that has not chosen yet. */
export async function createAccount(
  label: string,
  opts: { name: string | null; kind: 'PLAYER' | null },
): Promise<E2EPlayer> {
  const id = `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `${id}@playerz.test`;
  const passwordHash = await bcrypt.hash(E2E_PASSWORD, 4);
  const user = await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    return tx.user.create({
      data: { email, name: opts.name, accountKind: opts.kind, passwordHash },
    });
  });
  return { userId: user.id, email, password: E2E_PASSWORD, name: opts.name ?? '' };
}

export { destroyPlayer };

/**
 * Replace the native share sheet with a recorder, so the spec can see what
 * would have been shared. Headless Chromium's own `navigator.share` either is
 * absent or refuses, which would exercise only the copy fallback.
 */
export async function recordShares(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __shared: unknown[] };
    w.__shared = [];
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: unknown) => {
        w.__shared.push(data);
      },
    });
  });
}

/**
 * The booker shares a link from the booking detail, a second player opens it
 * in their own browser, signs in, joins, and both see the booking with both
 * names on it.
 */
export async function shareAndJoin(
  page: Page,
  browser: Browser,
  opts: {
    bookingId: string;
    venueName: string;
    friend: E2EPlayer;
    screenshot?: string;
    /** Where to save the invite page as the second player first sees it. */
    inviteScreenshot?: string;
    viewport?: { width: number; height: number };
  },
) {
  await recordShares(page);
  await page.goto(`/me/bookings/${opts.bookingId}`);
  await streamed(page);

  await page.getByRole('button', { name: mb.players.invite }).click();
  const sheet = page.getByRole('dialog', { name: mb.players.sheetTitle });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: mb.players.share }).click();

  const url = sheet.getByTestId('invite-url');
  await expect(url).toContainText('/invite/booking/');
  const link = (await url.textContent())!.trim();
  const shared = await page.evaluate(
    () => (window as unknown as { __shared: Array<{ url: string }> }).__shared,
  );
  expect(shared.map((s) => s.url)).toEqual([link]);
  if (opts.screenshot) await page.screenshot({ path: opts.screenshot });

  // The second player, in their own browser: the game first, then sign-in.
  const context = await browser.newContext(opts.viewport ? { viewport: opts.viewport } : {});
  const other = await context.newPage();
  try {
    const path = new URL(link).pathname;
    await other.goto(path);
    await streamed(other);
    await expect(other.getByText(opts.venueName, { exact: true })).toBeVisible();
    await expect(other.getByRole('link', { name: bg.bookingInvite.signInToJoin })).toBeVisible();

    await signIn(other, opts.friend);
    await other.goto(path);
    await streamed(other);
    await expect(other.getByRole('button', { name: bg.bookingInvite.join })).toBeVisible();
    if (opts.inviteScreenshot) await other.screenshot({ path: opts.inviteScreenshot });
    await other.getByRole('button', { name: bg.bookingInvite.join }).click();
    await expect(other).toHaveURL(new RegExp(`/me/bookings/${opts.bookingId}$`));
    await streamed(other);
    const theirs = other.getByTestId('booking-players');
    await expect(theirs).toContainText(mb.detail.you);
    await expect(other.getByRole('button', { name: mb.players.leave })).toBeVisible();
    // Not theirs to cancel.
    await expect(other.getByRole('button', { name: mb.detail.cancel })).toHaveCount(0);

    // In their Резервации too.
    await other.goto('/me/bookings');
    await streamed(other);
    await expect(other.getByText(opts.venueName).first()).toBeVisible();
  } finally {
    await context.close();
  }

  // The booker sees them on it.
  await page.keyboard.press('Escape');
  await page.reload();
  await streamed(page);
  await expect(page.getByTestId('booking-players')).toContainText(opts.friend.name);
}

/** A new account is asked "Играч или треньор?" first, picks Играч, and lands on Играй. */
export async function chooseKindJourney(page: Page, screenshot?: string) {
  await page.goto('/start');
  await expect(page).toHaveURL(/\/start\/kind$/);
  await expect(
    page.getByRole('heading', { level: 1, name: bg.onboarding.kind.title }),
  ).toBeVisible();
  const go = page.getByRole('button', { name: bg.onboarding.kind.continue });
  await expect(go).toBeDisabled();
  if (screenshot) await page.screenshot({ path: screenshot });

  await page.getByRole('radio', { name: new RegExp(bg.onboarding.kind.player.label) }).click();
  await go.click();
  await expect(page).toHaveURL(/\/venues$/);
  await expect(page.getByRole('heading', { level: 1, name: bg.venues.title })).toBeVisible();

  // Asked once: /start now sends a player to the player UI.
  await page.goto('/start');
  await expect(page).toHaveURL(/\/me\/bookings$/);
}
