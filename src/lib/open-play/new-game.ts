import type { ResourceSlotsDto } from '@/app/api/v1/_lib/dto';
import { hourGrid } from '@/lib/booking/hour-grid';

/**
 * «Създай игра» in one flow (#697, owner 2026-11-13: "I can't create a game
 * quickly"), as the phone's NewGameView: the sport, a club, the hour, the
 * players wanted; then the court is booked and its game opened in one go.
 * Plain functions, no directive: the page calls them, the unit tests pin them.
 */

const HOUR_MS = 3_600_000;

/** The flow's page; where every step owed before it sends the person back to. */
export const NEW_GAME_PATH = '/games/new';

/** How many more players the flow offers before the court is known: the phone's 1–7. */
export const MAX_SPOTS_ASKED = 7;

/**
 * A court's hours a game can still open on: the grid of the venue page, from
 * the club's cutoff on. An hour inside the cutoff can be booked, but its game
 * would take no requests (`canOpen` false), which the phone found on the local
 * server; so those are not offered here at all.
 */
export function gameHours(
  r: ResourceSlotsDto,
  minutes: number,
  now: number,
  cutoffHours: number,
  timeZone: string,
) {
  return hourGrid(r, minutes, now + Math.max(0, cutoffHours) * HOUR_MS, timeZone);
}

/** Whether a day's courts for the sport have any hour a game can open on. */
export function anyGameHour(
  resources: readonly ResourceSlotsDto[],
  sport: string,
  now: number,
  cutoffHours: number,
  timeZone: string,
): boolean {
  return resources
    .filter((r) => r.sport === sport)
    .some((r) =>
      gameHours(r, r.minBookingMinutes, now, cutoffHours, timeZone).some((g) =>
        g.cells.some((c) => c.offer !== null),
      ),
    );
}

/** The caller's own upcoming bookings that can look for players, as the phone's first section. */
export function bookingsToOpen<
  B extends {
    viewerRole: string;
    status: string;
    lesson: unknown;
    tournamentMatch: unknown;
  },
>(bookings: readonly B[], most = 2): B[] {
  return bookings
    .filter(
      (b) =>
        b.viewerRole === 'BOOKER' &&
        b.status === 'CONFIRMED' &&
        b.lesson === null &&
        b.tournamentMatch === null,
    )
    .slice(0, most);
}

/** The game's body: the players wanted, never more than the court holds. */
export function gameBody(
  wanted: { spots: number; levelMin: number | null; levelMax: number | null; note: string },
  maxSpots: number,
) {
  const lo = wanted.levelMin;
  const hi = wanted.levelMax;
  const note = wanted.note.trim();
  return {
    spots: Math.max(1, Math.min(wanted.spots, maxSpots)),
    levelMin: lo !== null && hi !== null ? Math.min(lo, hi) : lo,
    levelMax: lo !== null && hi !== null ? Math.max(lo, hi) : hi,
    note: note === '' ? null : note,
  };
}

/** What the flow ended in. A refused booking is thrown, as the booking threw it. */
export type CreateOutcome =
  | { kind: 'opened'; bookingId: string }
  /** The court is booked, but its game did not open: the booking page can open it. */
  | { kind: 'bookedNoGame'; bookingId: string };

/**
 * The booking first; then the booking's game is read for `canOpen` and
 * `maxSpots` (the court's free places), and opened with no more players than
 * those. As the phone: `POST /t/{club}/bookings`, `GET` then
 * `PUT /me/bookings/{id}/game`.
 */
export async function createGame(steps: {
  book: () => Promise<{ id: string } | undefined>;
  readGame: (bookingId: string) => Promise<{ canOpen: boolean; maxSpots: number }>;
  openGame: (bookingId: string, body: ReturnType<typeof gameBody>) => Promise<unknown>;
  wanted: Parameters<typeof gameBody>[0];
}): Promise<CreateOutcome | null> {
  const booking = await steps.book();
  if (!booking) return null;
  try {
    const game = await steps.readGame(booking.id);
    if (!game.canOpen || game.maxSpots < 1) return { kind: 'bookedNoGame', bookingId: booking.id };
    await steps.openGame(booking.id, gameBody(steps.wanted, game.maxSpots));
    return { kind: 'opened', bookingId: booking.id };
  } catch {
    return { kind: 'bookedNoGame', bookingId: booking.id };
  }
}
