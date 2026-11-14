import type { PrismaClient } from '@prisma/client';

import { getPublicVenue, SLOT_HOLDING_STATUSES } from '@/app-layer/repositories/availability';
import {
  getBookingForUserAcrossClubs,
  listBookingsForUserAcrossClubs,
} from '@/app-layer/repositories/booking';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import {
  cheapestPerStart,
  clockOf,
  daySpan,
  freeHourlyStarts,
  isLocalDate,
  localDayRange,
  rankTimes,
  type Interval,
  type PlayerTime,
} from '@/lib/assistant/slots';

import { freeBusyFor, type SyncDeps } from './google-calendar-sync';
import { loadVenueAvailability } from './venue-availability';

/**
 * `best_time_for_game` (owner 2026-11-14, #704): the two or three best times
 * for the players of a booking or game the ASKER is on.
 *
 * ## Privacy, and where each rule is held
 *
 *   - Only a booking the asker booked or was added to: read through
 *     `getBookingForUserAcrossClubs`, whose WHERE is the asker's id. Any
 *     other id answers "not one of your bookings", exactly like a foreign one.
 *   - Only the CONFIRMED players of it: the booker and the participant rows.
 *     A request to join that is not accepted is nobody here.
 *   - Busy or free only. `freeBusyFor` returns intervals and nothing else
 *     (Google's `calendar.freebusy`), and the other bookings are read as
 *     start and end; neither leaves this file except as "free", "unknown"
 *     or the absence of a time somebody is busy at. Nobody's intervals, and
 *     never what an event is, go back to the model.
 *   - Unknown is never free. A player without a connected Google Calendar is
 *     `unknown` at every time their playerz bookings do not already make busy,
 *     and the answer says who.
 */

export const MAX_DAYS = 14;
export const MAX_OPTIONS = 3;

export interface BestTimeInput {
  bookingId?: string;
  dateFrom: string;
  dateTo: string;
  timeFrom?: string;
  timeTo?: string;
  minutes?: number;
  /** Only these players (by name, as the booking shows them); the asker is always in. */
  players?: string[];
}

export class BestTimeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BestTimeInputError';
  }
}

export interface BestTimeOption {
  venueId: string;
  resourceId: string;
  court: string;
  startTs: string;
  endTs: string;
  local: string;
  minutes: number;
  priceCents: number;
  currency: string;
  everyoneFree: boolean;
  free: string[];
  unknown: Array<{ name: string; why: string }>;
}

export type BestTimeResult =
  | {
      /** No booking was named: these are the asker's, to choose from or ask about. */
      chooseBooking: Array<{
        bookingId: string;
        venue: string;
        sport: string;
        local: string;
        status: string;
      }>;
    }
  | {
      booking: { bookingId: string; venue: string; sport: string; local: string; minutes: number };
      players: Array<{ name: string; calendar: 'known' | 'unknown'; why?: string }>;
      guests: number;
      options: BestTimeOption[];
      /** The draft kind the top option is proposed as. */
      proposalKind: 'booking' | 'game';
      game: { spots: number; levelMin: number | null; levelMax: number | null } | null;
    };

const WHY: Record<string, string> = {
  not_connected: 'no Google Calendar connected',
  revoked: 'Google Calendar connection stopped working',
  unavailable: 'Google Calendar did not answer',
  disabled: 'calendar checks are off',
};

/** A player shown by name; an account with no name is "a player". */
function nameOf(u: { name: string | null } | undefined): string {
  return u?.name?.trim() || 'a player';
}

export async function bestTimeForGame(
  input: BestTimeInput,
  ctx: { userId: string; now: Date },
  deps: SyncDeps = {},
): Promise<BestTimeResult> {
  if (!input.bookingId) return { chooseBooking: await myRecentBookings(ctx.userId, ctx.now) };
  if (!isLocalDate(input.dateFrom) || !isLocalDate(input.dateTo)) {
    throw new BestTimeInputError('dateFrom and dateTo must be YYYY-MM-DD');
  }
  const span = daySpan(input.dateFrom, input.dateTo);
  if (span < 1) throw new BestTimeInputError('dateTo is before dateFrom');
  if (span > MAX_DAYS) throw new BestTimeInputError(`at most ${MAX_DAYS} days at a time`);

  // 1. The booking, only if it is the asker's, and its confirmed players.
  const loaded = await runAsSuperuser(async (db) => {
    const b = await getBookingForUserAcrossClubs(db, {
      userId: ctx.userId,
      bookingId: input.bookingId!,
    });
    if (!b) return null;
    const ids = [
      ...(b.bookedByUserId ? [b.bookedByUserId] : []),
      ...b.participants.flatMap((p) => (p.userId ? [p.userId] : [])),
    ];
    const unique = [...new Set(ids)];
    const users = await db.user.findMany({
      where: { id: { in: unique }, deletedAt: null },
      select: { id: true, name: true },
      take: unique.length,
    });
    const game = await db.openGame.findUnique({
      where: { bookingId: b.id },
      select: { spotsWanted: true, levelMin: true, levelMax: true, closedAt: true },
    });
    const venue = await getPublicVenue(db, b.resource.venue.id);
    return {
      b,
      users,
      guests: b.participants.filter((p) => !p.userId).length,
      game,
      venue,
    };
  });
  if (!loaded) throw new BestTimeInputError('that is not one of the person’s bookings');
  const { b, venue } = loaded;
  if (!venue) throw new BestTimeInputError('that club is not taking bookings now');

  let users = loaded.users;
  if (input.players && input.players.length > 0) {
    const wanted = input.players.map((n) => n.trim().toLowerCase()).filter(Boolean);
    users = users.filter(
      (u) => u.id === ctx.userId || wanted.some((w) => nameOf(u).toLowerCase().includes(w)),
    );
    if (users.length <= 1 && loaded.users.length > 1) {
      throw new BestTimeInputError(
        `none of those names is a player of this booking; its players are: ${loaded.users
          .filter((u) => u.id !== ctx.userId)
          .map(nameOf)
          .join(', ')}`,
      );
    }
  }

  const timeZone = venue.timezone;
  const { from, to } = localDayRange(input.dateFrom, input.dateTo, timeZone);
  const minutes = input.minutes ?? Math.round((b.endTs.getTime() - b.startTs.getTime()) / 60_000);
  const ids = users.map((u) => u.id);

  // 2. Their Google Calendars (busy or unknown) and their other playerz bookings.
  const [calendars, busy, resources] = await Promise.all([
    freeBusyFor(ids, from, to, deps),
    runAsSuperuser((db) => otherBookings(db, ids, b.id, from, to)),
    // 3. The club's free hours for this sport, as the app offers them.
    runAsSuperuser((db) => loadVenueAvailability(db, { venue, from, to })),
  ]);

  const players: PlayerTime[] = users.map((u) => {
    const cal = calendars[u.id];
    return {
      userId: u.id,
      name: u.id === ctx.userId ? 'you' : nameOf(u),
      calendar:
        cal && cal.known
          ? cal.busy.map((x) => ({ start: new Date(x.start), end: new Date(x.end) }))
          : null,
      ...(cal && !cal.known ? { unknownReason: WHY[cal.reason] ?? cal.reason } : {}),
      bookings: busy.get(u.id) ?? [],
    };
  });

  const sameSport = resources.filter((r) => r.resource.sport === b.resource.sport);
  const starts = cheapestPerStart(
    sameSport.flatMap((r) =>
      freeHourlyStarts(r, {
        now: ctx.now,
        timeZone,
        minutes,
        ...(input.timeFrom ? { timeFrom: input.timeFrom } : {}),
        ...(input.timeTo ? { timeTo: input.timeTo } : {}),
      }),
    ),
  );
  const ranked = rankTimes(starts, players, { timeZone, limit: MAX_OPTIONS });
  const court = new Map(sameSport.map((r) => [r.resource.id, r.resource]));

  const openGame = loaded.game && loaded.game.closedAt === null ? loaded.game : null;
  const bookingClock = clockOf(b.startTs, timeZone);
  return {
    booking: {
      bookingId: b.id,
      venue: b.resource.venue.name,
      sport: b.resource.sport,
      local: `${bookingClock.date} ${bookingClock.weekday} ${bookingClock.time}`,
      minutes,
    },
    players: players.map((p) => ({
      name: p.name,
      calendar: p.calendar === null ? 'unknown' : 'known',
      ...(p.calendar === null ? { why: p.unknownReason ?? WHY.not_connected } : {}),
    })),
    guests: loaded.guests,
    options: ranked.map((o) => {
      const c = clockOf(o.start.startTs, timeZone);
      const r = court.get(o.start.resourceId)!;
      return {
        venueId: venue.id,
        resourceId: o.start.resourceId,
        court: r.name,
        startTs: o.start.startTs.toISOString(),
        endTs: o.start.endTs.toISOString(),
        local: `${c.date} ${c.weekday} ${c.time}`,
        minutes: o.start.minutes,
        priceCents: o.start.priceCents,
        currency: r.currency,
        everyoneFree: o.unknown.length === 0,
        free: o.free.map((p) => p.name),
        unknown: o.unknown.map((p) => ({
          name: p.name,
          why: p.unknownReason ?? WHY.not_connected,
        })),
      };
    }),
    proposalKind: openGame ? 'game' : 'booking',
    game: openGame
      ? { spots: openGame.spotsWanted, levelMin: openGame.levelMin, levelMax: openGame.levelMax }
      : null,
  };
}

/**
 * The given people's other bookings in the window, start and end only, keyed
 * by person: a time they already play somewhere is busy whatever their
 * calendar says.
 */
async function otherBookings(
  db: PrismaClient,
  userIds: string[],
  excludeBookingId: string,
  from: Date,
  to: Date,
): Promise<Map<string, Interval[]>> {
  const out = new Map<string, Interval[]>();
  if (userIds.length === 0) return out;
  // guardrail-allow: cross-tenant — the players of a booking the asker is on,
  // by their ids; start and end only, nothing about what or where.
  const rows = await db.booking.findMany({
    where: {
      id: { not: excludeBookingId },
      status: { in: [...SLOT_HOLDING_STATUSES] },
      startTs: { lt: to },
      endTs: { gt: from },
      OR: [
        { bookedByUserId: { in: userIds } },
        { participants: { some: { userId: { in: userIds } } } },
      ],
    },
    select: {
      startTs: true,
      endTs: true,
      bookedByUserId: true,
      participants: { select: { userId: true } },
    },
    take: 500,
  });
  const wanted = new Set(userIds);
  for (const r of rows) {
    const who = new Set(
      [r.bookedByUserId, ...r.participants.map((p) => p.userId)].filter(
        (id): id is string => !!id && wanted.has(id),
      ),
    );
    for (const id of who) {
      const list = out.get(id) ?? [];
      list.push({ start: r.startTs, end: r.endTs });
      out.set(id, list);
    }
  }
  return out;
}

/** The asker's own bookings to pick from: upcoming first, then the latest played. */
async function myRecentBookings(userId: string, now: Date) {
  return runAsSuperuser(async (db) => {
    const upcoming = await listBookingsForUserAcrossClubs(db, {
      userId,
      when: 'upcoming',
      limit: 8,
      now,
    });
    const past =
      upcoming.items.length < 3
        ? (await listBookingsForUserAcrossClubs(db, { userId, when: 'past', limit: 3, now })).items
        : [];
    return [...upcoming.items, ...past].map((b) => {
      const c = clockOf(b.startTs, b.resource.venue.timezone);
      return {
        bookingId: b.id,
        venue: b.resource.venue.name,
        sport: b.resource.sport,
        local: `${c.date} ${c.weekday} ${c.time}`,
        status: b.status,
      };
    });
  });
}
