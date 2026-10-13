import { expect, type Browser, type Page } from '@playwright/test';

import bg from '../../../messages/bg.json';
import { signIn, testClientIp } from '../fixtures';
import { streamed } from './streamed';
import { prisma } from './create-isolated-tenant';
import type { E2EPlayer } from './create-player';
import type { PlayedClub } from './seed-my-bookings';

/**
 * Open play, two-sided (#376), shared by the 1280 px spec and its 393 px twin:
 * the booker and a second player, each in their own browser.
 *
 *   1. The booker opens their booking for more players, with a note.
 *   2. The second player finds the game on Игри and asks to join.
 *   3. The booker sees the request on the booking and accepts it. Every join
 *      is a request the booker answers (owner decision 2026-10-13, rule 1).
 *   4. The second player is on the booking, and both are in the game's chat.
 *
 * Needs MODULE_OPEN_PLAY=1 on the server: without it a booking's page has no
 * open-play section at all. playwright.config.ts sets it, as production does.
 */

const g = bg.games;

/** Screenshot paths, one per step, when a spec wants them. */
export interface OpenPlayShots {
  opened?: string;
  games?: string;
  asked?: string;
  request?: string;
  accepted?: string;
  chat?: string;
}

/** The seeded venue gets a public address, so its game card can link to it. */
export async function makeVenuePublic(club: PlayedClub): Promise<string> {
  const publicSlug = `e2e-open-play-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  await prisma().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE app_superuser`);
    await tx.venue.update({ where: { id: club.venueId }, data: { publicSlug } });
  });
  return publicSlug;
}

export async function openAskAcceptChat(
  page: Page,
  browser: Browser,
  opts: {
    bookingId: string;
    club: PlayedClub;
    friend: E2EPlayer;
    viewport: { width: number; height: number };
    shots?: OpenPlayShots;
  },
) {
  const { bookingId, club, friend, shots = {} } = opts;
  const note = 'Търсим още един за двойки.';
  // A phone's page is taller than its screen and the tab bar is fixed, so a
  // full-page capture would draw the bar across the middle.
  const shot = (path: string) => ({ path, fullPage: opts.viewport.width >= 768 });
  const main = page.getByRole('main');

  // ── 1. The booker opens the game ──
  await page.goto(`/me/bookings/${bookingId}`);
  await streamed(page);
  await main.getByTestId('booking-game-open').click();
  const dialog = page.getByTestId('open-game-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('open-game-note').fill(note);
  await page.getByTestId('open-game-submit').click();
  await expect(main.getByTestId('booking-game-state')).toBeVisible();
  await expect(main.getByTestId('booking-game')).toContainText(note);
  if (shots.opened) await page.screenshot(shot(shots.opened));

  // ── 2. The second player finds it on Игри and asks ──
  // A second browser, so a second client: the fixture gives the test's own
  // context an address (#539), and a context opened here takes one too.
  const context = await browser.newContext({
    viewport: opts.viewport,
    locale: 'bg-BG',
    extraHTTPHeaders: { 'x-forwarded-for': testClientIp() },
  });
  const other = await context.newPage();
  try {
    await signIn(other, friend);
    await other.goto('/games');
    await streamed(other);
    const theirs = other.getByRole('main');
    const card = theirs.getByTestId('game-card').filter({ hasText: club.venueName });
    await expect(card).toBeVisible();
    await expect(card).toContainText(note);
    if (shots.games) await other.screenshot(shot(shots.games));

    // No instant join: the only way in is to ask.
    await card.getByTestId('game-ask').click();
    const ask = other.getByTestId('ask-dialog');
    await expect(ask).toBeVisible();
    await ask.getByTestId('ask-note').fill('Играя от две години, ниво 3.');
    await other.getByTestId('ask-submit').click();
    await expect(card.getByTestId('game-request-status')).toHaveText(g.status.PENDING);
    if (shots.asked) await other.screenshot(shot(shots.asked));

    // ── 3. The booker sees the request and accepts it ──
    await page.reload();
    await streamed(page);
    const request = main.getByTestId('booking-game-request').filter({ hasText: friend.name });
    await expect(request).toBeVisible();
    await expect(request).toContainText('Играя от две години, ниво 3.');
    if (shots.request) await page.screenshot(shot(shots.request));
    await request.getByTestId('booking-game-accept').click();
    await expect(main.getByTestId('booking-players')).toContainText(friend.name);
    await expect(main.getByTestId('booking-game-chat')).toBeVisible();
    if (shots.accepted) await page.screenshot(shot(shots.accepted));

    // ── 4. The second player is in the game: «Моите заявки», then the booking ──
    await other.goto('/games?tab=mine');
    await streamed(other);
    const mine = theirs.getByTestId('my-game-requests').getByTestId('game-card');
    await expect(mine.filter({ hasText: club.venueName })).toBeVisible();
    await expect(mine.getByTestId('game-request-status').first()).toHaveText(g.status.ACCEPTED);
    await mine.getByTestId('game-booking').first().click();
    await expect(other).toHaveURL(new RegExp(`/me/bookings/${bookingId}$`));
    await streamed(other);
    await expect(theirs.getByTestId('booking-game-joined')).toBeVisible();

    // The game's chat: the joiner writes, the booker reads it.
    await theirs.getByTestId('booking-game-chat').click();
    await expect(other).toHaveURL(/\/messages\/c[a-z0-9]+$/);
    await theirs.getByTestId('conversation-input').fill('Ще донеса топки.');
    await theirs.getByTestId('conversation-send').click();
    await expect(theirs.getByTestId('conversation-messages')).toContainText('Ще донеса топки.');

    await main.getByTestId('booking-game-chat').click();
    await expect(page).toHaveURL(/\/messages\/c[a-z0-9]+$/);
    await expect(main.getByTestId('conversation-messages')).toContainText('Ще донеса топки.', {
      timeout: 15_000,
    });
    if (shots.chat) await page.screenshot(shot(shots.chat));
  } finally {
    await context.close();
  }
}
