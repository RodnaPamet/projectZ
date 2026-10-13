import {
  Prisma,
  type OpenGameRequestStatus,
  type PrismaClient,
  type SportType,
} from '@prisma/client';

import {
  BookingFullError,
  BookingNotFoundForPlayersError,
  firstName,
  insertParticipant,
  leaveBooking,
  lockBooking,
  locate,
  locateAsBooker,
  requirePlayerAccount,
  type LockedBooking,
} from '@/app-layer/usecases/booking-players';
import { assertMayBookOnline } from '@/app-layer/usecases/booking-rules';
import {
  blockedEitherWay,
  isLivePlayer,
  sportsOf,
  type SportLevelCard,
} from '@/app-layer/usecases/messaging-directory';
import { notifyOpenPlay, type OpenPlayEvent } from '@/app-layer/usecases/booking-notifications';
import { cutoffPassed, OpenPlayError } from '@/app-layer/usecases/open-play-roster';
import { publicVenueFilter } from '@/app-layer/repositories/public-venue';
import { appendAuditEntry, AUDIT_ACTIONS } from '@/lib/audit';
import { playerCancellableUntil, playerMayCancel } from '@/lib/booking/cutoff';
import { runAsSuperuser, runInTenantContext } from '@/lib/db/rls-middleware';
import { RateLimitedError } from '@/lib/errors/types';
import { citySpellings } from '@/lib/geo/cities';
import { avatarUrlOf } from '@/lib/media/avatar-url';
import { decodeCursor, encodeCursor } from '@/lib/messaging/cursor';
import { OPEN_PLAY_NOTE_MAX } from '@/lib/open-play/limits';
import { MAX_SPORT_LEVEL, MIN_SPORT_LEVEL } from '@/lib/profile/limits';
import { checkRateLimit, type RateLimitConfig } from '@/lib/security/rate-limit';
import { isRateLimitBypassed } from '@/lib/security/rate-limit-middleware';
import { sanitizePlainText } from '@/lib/security/sanitize';

/**
 * Open play (#376, Q19/Q51; owner decisions 2026-10-13).
 *
 *   - A booker opens their booking: how many more players, an optional level
 *     wish on the booking's sport, an optional note. They close or reopen it.
 *   - Anyone sees it on /games (Игри) and the venue page. A signed-in player
 *     ASKS, with an optional note. Every join is a request the booker accepts
 *     or declines, whatever the asker's level (rule 1): the range is a wish.
 *   - An accepted player becomes a `BookingParticipant` (#358), so they are in
 *     the club's diary, their Резервации, and every count of who plays.
 *   - A joiner leaves until the club's cancellation cutoff, and the booker
 *     takes one off until then (rule 2; `open-play-roster.ts`). After it they
 *     are on the booking and the no-show rule applies (`markPlayerNoShow`).
 *   - A request nobody answered lapses at the cutoff and the player is told
 *     (rule 4): `lapseOpenPlayRequests`, run by the reminders cron, and every
 *     read and write here treats a PENDING request past the cutoff as lapsed,
 *     so nothing waits for the sweep to be right.
 *   - Payment stays at the club. Nothing here moves money.
 *
 * ═══ TWO PHASES, AS booking-players.ts ═══
 *
 * `open_game` and `open_game_request` are tenant tables under RLS (P61). The
 * first phase is one BYPASSRLS read scoped by what the caller holds (a booking
 * they booked or are on, a game id they were shown, their own user id) that
 * returns a tenant id; every write then runs bound to that tenant, re-reading
 * the booking under its row lock (`lockBooking`), so the capacity race is the
 * one #358 already serialises. The public listing is a read only, across
 * clubs, and never returns a user id, a booking id, an email or a phone.
 */

export { OPEN_PLAY_NOTE_MAX };
/** How far ahead Игри lists games: near-term play, not a season's schedule. */
export const GAMES_HORIZON_DAYS = 14;
export const GAMES_PAGE_SIZE = 30;
/** A booker answers at most this many requests on one game's card. */
export const REQUESTS_SHOWN = 100;
/** How many of one's own requests "Моите заявки" lists. */
export const MY_REQUESTS_LIMIT = 50;
/** One's requests for games that started up to this long ago stay listed. */
const MY_REQUESTS_PAST_DAYS = 7;

/**
 * Asking is a write that notifies somebody else (the booker's bell, and an
 * email), so it is rate limited per person, like a message request (#375).
 */
export const OPEN_PLAY_ASK_LIMIT: RateLimitConfig = { maxAttempts: 20, windowMs: 24 * 3_600_000 };

const DAY_MS = 86_400_000;

// ─── Errors ─────────────────────────────────────────────────────────────

const gameNotFound = () => new OpenPlayError('GAME_NOT_FOUND', 404, 'That game was not found.');
const requestNotFound = () =>
  new OpenPlayError('REQUEST_NOT_FOUND', 404, 'That request was not found.');
const gameClosed = () =>
  new OpenPlayError('GAME_CLOSED', 409, 'This game is no longer looking for players.');
const gameFull = () =>
  new OpenPlayError('GAME_FULL', 409, 'Every spot in this game is taken. One may open again.');

// ─── Shared reads ───────────────────────────────────────────────────────

/** A PENDING request past the club's cutoff has lapsed, whether or not the sweep ran. */
export function effectiveStatus(
  status: OpenGameRequestStatus,
  startTs: Date,
  cutoffHours: number,
  now: Date,
): OpenGameRequestStatus {
  return status === 'PENDING' && !playerMayCancel(startTs, cutoffHours, now) ? 'LAPSED' : status;
}

/** How many more players the game takes now: the booker's wish, and the court's room. */
export function spotsLeftOf(input: {
  spotsWanted: number;
  accepted: number;
  capacity: number;
  participants: number;
}): number {
  return Math.max(
    0,
    Math.min(input.spotsWanted - input.accepted, input.capacity - 1 - input.participants),
  );
}

function cleanNote(raw: string | null | undefined): string | null {
  const text = sanitizePlainText(raw ?? '').trim();
  if (!text) return null;
  if (text.length > OPEN_PLAY_NOTE_MAX) {
    throw new OpenPlayError(
      'NOTE_TOO_LONG',
      400,
      `A note is at most ${OPEN_PLAY_NOTE_MAX} characters.`,
    );
  }
  return text;
}

function checkLevels(levelMin: number | null, levelMax: number | null): void {
  const ok = (l: number | null) =>
    l === null || (Number.isInteger(l) && l >= MIN_SPORT_LEVEL && l <= MAX_SPORT_LEVEL);
  if (
    !ok(levelMin) ||
    !ok(levelMax) ||
    (levelMin !== null && levelMax !== null && levelMin > levelMax)
  ) {
    throw new OpenPlayError('LEVELS_INVALID', 400, 'The level range is not valid.');
  }
}

// ─── What everyone sees of a game ───────────────────────────────────────

export interface OpenGameSummary {
  id: string;
  sport: SportType;
  resourceType: string;
  courtName: string;
  venue: { id: string; slug: string; name: string; city: string };
  startTs: Date;
  endTs: Date;
  timezone: string;
  /** Asking is possible until then; an unanswered request lapses at it. */
  cutoffAt: Date;
  capacity: number;
  /** On the booking now, the booker included. */
  playersCount: number;
  spotsLeft: number;
  /** Listed on Игри: open, before the cutoff, with a spot left. */
  open: boolean;
  levelMin: number | null;
  levelMax: number | null;
  note: string | null;
  booker: { firstName: string | null; avatarUrl: string | null };
  /** The signed-in viewer's part in it, or null signed out. */
  viewer: {
    isBooker: boolean;
    isPlaying: boolean;
    /** The booking, for the booker and the players on it only: their own page. */
    bookingId: string | null;
    request: { id: string; status: OpenGameRequestStatus } | null;
  } | null;
}

const GAME_SELECT = {
  id: true,
  tenantId: true,
  spotsWanted: true,
  levelMin: true,
  levelMax: true,
  note: true,
  closedAt: true,
  booking: {
    select: {
      id: true,
      status: true,
      startTs: true,
      endTs: true,
      bookedByUserId: true,
      participants: { select: { id: true, userId: true } },
      resource: {
        select: {
          name: true,
          sport: true,
          resourceType: true,
          capacity: true,
          venue: {
            select: {
              id: true,
              slug: true,
              name: true,
              city: true,
              timezone: true,
              cancellationCutoffHours: true,
            },
          },
        },
      },
    },
  },
  _count: { select: { requests: { where: { status: 'ACCEPTED' as const } } } },
} satisfies Prisma.OpenGameSelect;

type GameRow = Prisma.OpenGameGetPayload<{ select: typeof GAME_SELECT }>;

function isListable(g: GameRow, now: Date): boolean {
  const b = g.booking;
  return (
    g.closedAt === null &&
    b.status === 'CONFIRMED' &&
    playerMayCancel(b.startTs, b.resource.venue.cancellationCutoffHours, now) &&
    spotsOf(g) > 0
  );
}

function spotsOf(g: GameRow): number {
  return spotsLeftOf({
    spotsWanted: g.spotsWanted,
    accepted: g._count.requests,
    capacity: g.booking.resource.capacity,
    participants: g.booking.participants.length,
  });
}

/**
 * The summaries of `rows`, with the bookers' first names and the viewer's own
 * part. One read for the bookers, one for the viewer's requests.
 */
async function summarise(
  db: PrismaClient,
  rows: GameRow[],
  viewerId: string | null,
  now: Date,
): Promise<OpenGameSummary[]> {
  if (rows.length === 0) return [];
  const bookerIds = [
    ...new Set(rows.flatMap((g) => (g.booking.bookedByUserId ? [g.booking.bookedByUserId] : []))),
  ];
  const [bookers, mine] = await Promise.all([
    db.user.findMany({
      where: { id: { in: bookerIds } },
      select: { id: true, name: true, avatarUrl: true, deletedAt: true },
      take: bookerIds.length,
    }),
    viewerId
      ? // guardrail-allow: cross-tenant — the viewer's own requests, on games already read.
        db.openGameRequest.findMany({
          where: { userId: viewerId, gameId: { in: rows.map((g) => g.id) } },
          select: { id: true, gameId: true, status: true },
          take: rows.length,
        })
      : Promise.resolve([]),
  ]);
  const byId = new Map(bookers.map((u) => [u.id, u]));
  const myRequest = new Map(mine.map((r) => [r.gameId, r]));

  return rows.map((g): OpenGameSummary => {
    const b = g.booking;
    const v = b.resource.venue;
    const booker = b.bookedByUserId ? byId.get(b.bookedByUserId) : undefined;
    const live = booker && !booker.deletedAt ? booker : undefined;
    const request = myRequest.get(g.id);
    const playing =
      !!viewerId &&
      (b.bookedByUserId === viewerId || b.participants.some((p) => p.userId === viewerId));
    return {
      id: g.id,
      sport: b.resource.sport,
      resourceType: b.resource.resourceType,
      courtName: b.resource.name,
      venue: { id: v.id, slug: v.slug, name: v.name, city: v.city },
      startTs: b.startTs,
      endTs: b.endTs,
      timezone: v.timezone,
      cutoffAt: playerCancellableUntil(b.startTs, v.cancellationCutoffHours),
      capacity: b.resource.capacity,
      playersCount: (b.bookedByUserId ? 1 : 0) + b.participants.length,
      spotsLeft: spotsOf(g),
      open: isListable(g, now),
      levelMin: g.levelMin,
      levelMax: g.levelMax,
      note: g.note,
      booker: {
        firstName: firstName(live?.name),
        avatarUrl: live ? avatarUrlOf(live.avatarUrl) : null,
      },
      viewer: viewerId
        ? {
            isBooker: b.bookedByUserId === viewerId,
            isPlaying: playing,
            bookingId: playing ? b.id : null,
            request: request
              ? {
                  id: request.id,
                  status: effectiveStatus(
                    request.status,
                    b.startTs,
                    v.cancellationCutoffHours,
                    now,
                  ),
                }
              : null,
          }
        : null,
    };
  });
}

// ─── Игри: the listing ──────────────────────────────────────────────────

export interface OpenGamesFilter {
  sport?: SportType;
  /** A calendar day at the venue, `YYYY-MM-DD`. */
  date?: string;
  city?: string;
  venueId?: string;
}

export interface OpenGamesPage {
  items: OpenGameSummary[];
  nextCursor: string | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Open games, soonest first: open, CONFIRMED, before the club's cutoff (an
 * ask after it could only lapse), within `GAMES_HORIZON_DAYS`, with a spot
 * left, at a public venue. Anyone may read it. A signed-in viewer does not see
 * a game whose booker they are in a block with, either way round (#375): the
 * two would otherwise end up in one chat.
 *
 * The filters run in SQL, the cutoff and the spots too, so the keyset page
 * (start, id) is exact: a page is never short because rows were dropped after
 * the read.
 */
export async function listOpenGames(
  filter: OpenGamesFilter,
  opts: { viewerId?: string | null; cursor?: string | null; limit?: number; now?: Date } = {},
): Promise<OpenGamesPage> {
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(opts.limit ?? GAMES_PAGE_SIZE, 1), GAMES_PAGE_SIZE);
  const cursor = decodeCursor(opts.cursor);
  const horizon = new Date(now.getTime() + GAMES_HORIZON_DAYS * DAY_MS);
  const viewerId = opts.viewerId ?? null;
  const day = filter.date && ISO_DAY.test(filter.date) ? filter.date : null;

  // guardrail-allow: cross-tenant — the public Игри listing, at every public
  // venue; it returns no user id, booking id, email or phone.
  return runAsSuperuser(async (db) => {
    const [pub, blocked] = await Promise.all([
      publicVenueFilter(db),
      viewerId ? blockedEitherWay(db, viewerId) : Promise.resolve([]),
    ]);

    const where: Prisma.Sql[] = [
      Prisma.sql`g."closedAt" IS NULL`,
      Prisma.sql`b.status = 'CONFIRMED'`,
      Prisma.sql`b."startTs" > ${now}`,
      Prisma.sql`b."startTs" <= ${horizon}`,
      // playerMayCancel: now <= start - cutoff.
      Prisma.sql`b."startTs" - make_interval(hours => v."cancellationCutoffHours") >= ${now}`,
      Prisma.sql`g."spotsWanted" > (SELECT count(*) FROM "open_game_request" q
                                     WHERE q."gameId" = g.id AND q.status = 'ACCEPTED')`,
      Prisma.sql`r.capacity - 1 > (SELECT count(*) FROM "booking_participant" p
                                    WHERE p."bookingId" = b.id)`,
      pub.sql('v'),
    ];
    if (filter.sport) where.push(Prisma.sql`r.sport::text = ${filter.sport}`);
    if (filter.venueId) where.push(Prisma.sql`v.id = ${filter.venueId}`);
    if (filter.city) {
      const spellings = citySpellings(filter.city).map((c) => c.toLowerCase());
      where.push(Prisma.sql`lower(v.city) IN (${Prisma.join(spellings)})`);
    }
    if (day) {
      where.push(Prisma.sql`to_char(b."startTs" AT TIME ZONE v.timezone, 'YYYY-MM-DD') = ${day}`);
    }
    if (blocked.length > 0) {
      where.push(Prisma.sql`b."bookedByUserId" NOT IN (${Prisma.join(blocked)})`);
    }
    if (cursor) {
      where.push(Prisma.sql`(b."startTs", g.id) > (${cursor.at}, ${cursor.id})`);
    }

    const ids = await db.$queryRaw<Array<{ id: string; startTs: Date }>>`
      SELECT g.id, b."startTs" AS "startTs"
        FROM "open_game" g
        JOIN "booking" b ON b.id = g."bookingId"
        JOIN "court" r ON r.id = b."resourceId"
        JOIN "venue" v ON v.id = r."venueId"
       WHERE ${Prisma.join(where, ' AND ')}
       ORDER BY b."startTs" ASC, g.id ASC
       LIMIT ${limit + 1}`;

    const hasMore = ids.length > limit;
    const pageIds = (hasMore ? ids.slice(0, limit) : ids).map((r) => r.id);
    const rows = pageIds.length
      ? // guardrail-allow: cross-tenant — the page the public listing just chose.
        await db.openGame.findMany({
          where: { id: { in: pageIds } },
          select: GAME_SELECT,
          take: pageIds.length,
        })
      : [];
    const order = new Map(pageIds.map((id, i) => [id, i]));
    rows.sort((a, z) => (order.get(a.id) ?? 0) - (order.get(z.id) ?? 0));

    const last = hasMore ? ids[limit - 1] : undefined;
    return {
      items: await summarise(db, rows, viewerId, now),
      nextCursor: last ? encodeCursor({ at: last.startTs, id: last.id }) : null,
    };
  });
}

/**
 * One game, for its card and the ask dialog. Anyone sees a listable game; a
 * signed-in player also sees one they asked to join or play in after it
 * stopped being listed (filled, closed, past the cutoff). Null otherwise,
 * which the route answers 404.
 */
export async function getOpenGame(
  gameId: string,
  opts: { viewerId?: string | null; now?: Date } = {},
): Promise<OpenGameSummary | null> {
  const now = opts.now ?? new Date();
  const viewerId = opts.viewerId ?? null;
  // guardrail-allow: cross-tenant — one game by id, shown only when public or
  // the viewer's own (their request, or a booking they are on).
  return runAsSuperuser(async (db) => {
    const g = await db.openGame.findUnique({ where: { id: gameId }, select: GAME_SELECT });
    if (!g) return null;
    const [summary] = await summarise(db, [g], viewerId, now);
    if (!summary) return null;
    const related = summary.viewer && (summary.viewer.isPlaying || summary.viewer.request);
    if (!summary.open && !related) return null;
    if (summary.open && !related && viewerId && g.booking.bookedByUserId) {
      const blocked = await blockedEitherWay(db, viewerId);
      if (blocked.includes(g.booking.bookedByUserId)) return null;
    }
    return summary;
  });
}

// ─── The booker's side ──────────────────────────────────────────────────

export interface RequestCard {
  id: string;
  status: OpenGameRequestStatus;
  note: string | null;
  askedAt: Date;
  decidedAt: Date | null;
  /** The place on the booking, while ACCEPTED: what the booker removes by. */
  participantId: string | null;
  /** The same public card as messaging's (#375): name, picture, sports and levels. */
  player: {
    userId: string;
    name: string | null;
    avatarUrl: string | null;
    sports: SportLevelCard[];
    deleted: boolean;
  };
}

export interface BookingGameView {
  viewerRole: 'BOOKER' | 'PARTICIPANT';
  bookingId: string;
  sport: SportType;
  /** The club's cancellation cutoff for this booking. */
  cutoffAt: Date;
  /** The booker may open (or reopen, or change) the game now. */
  canOpen: boolean;
  /** At most this many more players can be asked for now: the court's free places. */
  maxSpots: number;
  game: {
    id: string;
    /** Listed on Игри now. */
    open: boolean;
    closedAt: Date | null;
    spotsLeft: number;
    accepted: number;
    levelMin: number | null;
    levelMax: number | null;
    note: string | null;
  } | null;
  /** The booker's: every request, waiting ones first. Empty for anyone else. */
  requests: RequestCard[];
  /** A participant's own request, when they joined through open play. */
  myRequest: { id: string; status: OpenGameRequestStatus } | null;
}

const ORDER: Record<OpenGameRequestStatus, number> = {
  PENDING: 0,
  ACCEPTED: 1,
  LEFT: 2,
  REMOVED: 2,
  DECLINED: 3,
  WITHDRAWN: 3,
  LAPSED: 3,
  CLOSED: 3,
};

/**
 * The game on a booking, for the booking's page: the booker's controls and
 * requests, or a participant's own standing. Null for a booking the caller is
 * not on (404), as every booking read is.
 */
export async function getBookingGame(input: {
  userId: string;
  bookingId: string;
  now?: Date;
}): Promise<BookingGameView | null> {
  const at = await locate(input.userId, input.bookingId);
  if (!at) return null;
  const now = input.now ?? new Date();

  const read = await runInTenantContext(at.tenantId, async (tx) => {
    const b = await tx.booking.findFirst({
      where: { id: input.bookingId, tenantId: at.tenantId },
      select: {
        status: true,
        startTs: true,
        participants: { select: { id: true, userId: true } },
        resource: {
          select: {
            sport: true,
            capacity: true,
            venue: { select: { cancellationCutoffHours: true } },
          },
        },
        openGame: {
          select: {
            id: true,
            spotsWanted: true,
            levelMin: true,
            levelMax: true,
            note: true,
            closedAt: true,
            requests: {
              select: {
                id: true,
                userId: true,
                status: true,
                note: true,
                askedAt: true,
                decidedAt: true,
                participantId: true,
              },
              orderBy: { askedAt: 'asc' },
              take: REQUESTS_SHOWN,
            },
          },
        },
      },
    });
    return b;
  });
  if (!read) return null;

  const cutoffHours = read.resource.venue.cancellationCutoffHours;
  const beforeCutoff = playerMayCancel(read.startTs, cutoffHours, now);
  const free = Math.max(0, read.resource.capacity - 1 - read.participants.length);
  const g = read.openGame;
  const accepted = g ? g.requests.filter((r) => r.status === 'ACCEPTED').length : 0;
  const spotsLeft = g
    ? spotsLeftOf({
        spotsWanted: g.spotsWanted,
        accepted,
        capacity: read.resource.capacity,
        participants: read.participants.length,
      })
    : 0;

  const base = {
    viewerRole: at.role,
    bookingId: input.bookingId,
    sport: read.resource.sport,
    cutoffAt: playerCancellableUntil(read.startTs, cutoffHours),
    canOpen: at.role === 'BOOKER' && read.status === 'CONFIRMED' && beforeCutoff && free > 0,
    maxSpots: free,
    game: g
      ? {
          id: g.id,
          open: g.closedAt === null && read.status === 'CONFIRMED' && beforeCutoff && spotsLeft > 0,
          closedAt: g.closedAt,
          spotsLeft,
          accepted,
          levelMin: g.levelMin,
          levelMax: g.levelMax,
          note: g.note,
        }
      : null,
  };

  if (at.role !== 'BOOKER') {
    const mine = g?.requests.find((r) => r.userId === input.userId);
    return {
      ...base,
      requests: [],
      myRequest: mine
        ? { id: mine.id, status: effectiveStatus(mine.status, read.startTs, cutoffHours, now) }
        : null,
    };
  }

  const people = g?.requests.map((r) => r.userId) ?? [];
  // guardrail-allow: cross-tenant — the public cards (#375) of the people who
  // asked to join the caller's own game; ids from an RLS-bound read.
  const cards = await runAsSuperuser(async (db) => {
    const [users, sports] = await Promise.all([
      people.length
        ? db.user.findMany({
            where: { id: { in: people } },
            select: { id: true, name: true, avatarUrl: true, deletedAt: true },
            take: people.length,
          })
        : Promise.resolve([]),
      sportsOf(db, people),
    ]);
    return { users: new Map(users.map((u) => [u.id, u])), sports };
  });

  const requests = (g?.requests ?? [])
    .map((r): RequestCard => {
      const u = cards.users.get(r.userId);
      const gone = !u || !!u.deletedAt;
      return {
        id: r.id,
        status: effectiveStatus(r.status, read.startTs, cutoffHours, now),
        note: r.note,
        askedAt: r.askedAt,
        decidedAt: r.decidedAt,
        participantId: r.participantId,
        player: {
          userId: r.userId,
          name: gone ? null : (u?.name ?? null),
          avatarUrl: gone ? null : avatarUrlOf(u?.avatarUrl),
          sports: gone ? [] : (cards.sports.get(r.userId) ?? []),
          deleted: gone,
        },
      };
    })
    .sort(
      (x, y) =>
        ORDER[x.status] - ORDER[y.status] ||
        (x.status === 'PENDING'
          ? x.askedAt.getTime() - y.askedAt.getTime()
          : (y.decidedAt ?? y.askedAt).getTime() - (x.decidedAt ?? x.askedAt).getTime()),
    );

  return { ...base, requests, myRequest: null };
}

/**
 * Open the booking to other players, or change what an open one asks for, or
 * reopen a closed one. `spots` is how many MORE players the booker wants now,
 * at most the court's free places; the game then takes the players already
 * accepted plus that many.
 */
export async function openGame(input: {
  userId: string;
  bookingId: string;
  spots: number;
  levelMin?: number | null;
  levelMax?: number | null;
  note?: string | null;
  now?: Date;
}): Promise<BookingGameView> {
  const tenantId = await locateAsBooker(input.userId, input.bookingId);
  const now = input.now ?? new Date();
  const levelMin = input.levelMin ?? null;
  const levelMax = input.levelMax ?? null;
  checkLevels(levelMin, levelMax);
  const note = cleanNote(input.note);
  if (!Number.isInteger(input.spots) || input.spots < 1) {
    throw new OpenPlayError('SPOTS_INVALID', 400, 'Ask for at least one player.');
  }

  await runInTenantContext(tenantId, async (tx) => {
    const b = await lockBooking(tx, tenantId, input.bookingId);
    if (!b || b.bookedByUserId !== input.userId) throw new BookingNotFoundForPlayersError();
    if (b.status !== 'CONFIRMED') {
      throw new OpenPlayError(
        'GAME_NOT_OPENABLE',
        409,
        'Only a confirmed booking that has not started can look for players.',
      );
    }
    if (!playerMayCancel(b.startTs, b.cutoffHours, now)) throw cutoffPassed();

    const free = b.capacity - 1 - b.participants.length;
    if (free <= 0) throw new BookingFullError(b.capacity);
    if (input.spots > free) {
      throw new OpenPlayError(
        'SPOTS_UNAVAILABLE',
        409,
        `The court has room for ${free} more player(s) at most.`,
      );
    }

    const existing = await tx.openGame.findUnique({
      where: { bookingId: b.id },
      select: { id: true, closedAt: true, openedAt: true },
    });
    const accepted = existing
      ? await tx.openGameRequest.count({
          where: { tenantId, gameId: existing.id, status: 'ACCEPTED' },
        })
      : 0;
    const data = {
      spotsWanted: accepted + input.spots,
      levelMin,
      levelMax,
      note,
      closedAt: null,
      openedAt: existing && !existing.closedAt ? existing.openedAt : now,
    };
    const game = existing
      ? await tx.openGame.update({ where: { id: existing.id }, data, select: { id: true } })
      : await tx.openGame.create({
          data: { tenantId, bookingId: b.id, ...data },
          select: { id: true },
        });

    await appendAuditEntry(tx, {
      tenantId,
      actorUserId: input.userId,
      entity: 'OpenGame',
      entityId: game.id,
      action:
        existing && !existing.closedAt
          ? AUDIT_ACTIONS.OPEN_GAME_UPDATED
          : AUDIT_ACTIONS.OPEN_GAME_OPENED,
      details: `Looking for ${input.spots} more player(s) on booking ${b.id}`,
      detailsJson: {
        category: 'booking',
        bookingId: b.id,
        spots: input.spots,
        levelMin,
        levelMax,
        hasNote: note !== null,
      },
    });
  });

  const view = await getBookingGame({ userId: input.userId, bookingId: input.bookingId, now });
  if (!view) throw new BookingNotFoundForPlayersError();
  return view;
}

/**
 * Stop looking for players. The requests still waiting close, and each asker
 * is told. The players already accepted stay on the booking. Idempotent.
 */
export async function closeGame(input: {
  userId: string;
  bookingId: string;
  now?: Date;
}): Promise<BookingGameView> {
  const tenantId = await locateAsBooker(input.userId, input.bookingId);
  const now = input.now ?? new Date();

  const closed = await runInTenantContext(tenantId, async (tx) => {
    const b = await lockBooking(tx, tenantId, input.bookingId);
    if (!b || b.bookedByUserId !== input.userId) throw new BookingNotFoundForPlayersError();
    return closeGameIn(tx, tenantId, b.id, { actorUserId: input.userId, now });
  });
  await notifyAll(tenantId, closed, 'closed');

  const view = await getBookingGame({ userId: input.userId, bookingId: input.bookingId, now });
  if (!view) throw new BookingNotFoundForPlayersError();
  return view;
}

/**
 * Close a booking's game inside a tenant transaction: the booker closing it,
 * or `cancelBooking` cancelling the booking under it. Returns the requests
 * that were waiting and are now CLOSED, for their askers to be told after
 * the commit (`notifyOpenPlayClosed`). Nothing when there is no open game.
 */
export async function closeGameIn(
  tx: PrismaClient,
  tenantId: string,
  bookingId: string,
  opts: { actorUserId: string | null; now: Date },
): Promise<string[]> {
  const game = await tx.openGame.findFirst({
    where: { tenantId, bookingId, closedAt: null },
    select: { id: true },
  });
  if (!game) return [];

  await tx.openGame.updateMany({
    where: { id: game.id, tenantId, closedAt: null },
    data: { closedAt: opts.now },
  });
  const waiting = await tx.openGameRequest.findMany({
    where: { tenantId, gameId: game.id, status: 'PENDING' },
    select: { id: true },
    take: 1_000,
  });
  if (waiting.length > 0) {
    await tx.openGameRequest.updateMany({
      where: { id: { in: waiting.map((r) => r.id) }, tenantId, status: 'PENDING' },
      data: { status: 'CLOSED', decidedAt: opts.now },
    });
  }
  await appendAuditEntry(tx, {
    tenantId,
    actorUserId: opts.actorUserId,
    entity: 'OpenGame',
    entityId: game.id,
    action: AUDIT_ACTIONS.OPEN_GAME_CLOSED,
    details: `Stopped looking for players on booking ${bookingId}`,
    detailsJson: { category: 'booking', bookingId, closedRequests: waiting.length },
  });
  return waiting.map((r) => r.id);
}

/** Tell the askers whose requests a close or a cancellation closed. Never throws. */
export async function notifyOpenPlayClosed(tenantId: string, requestIds: string[]): Promise<void> {
  await notifyAll(tenantId, requestIds, 'closed');
}

async function notifyAll(tenantId: string, requestIds: string[], event: OpenPlayEvent) {
  for (const requestId of requestIds) await notifyOpenPlay({ tenantId, requestId, event });
}

/** Accept or decline one request. Accepting puts the player on the booking. */
export async function answerRequest(input: {
  userId: string;
  bookingId: string;
  requestId: string;
  decision: 'accept' | 'decline';
  now?: Date;
}): Promise<BookingGameView> {
  const tenantId = await locateAsBooker(input.userId, input.bookingId);
  const now = input.now ?? new Date();

  const changed = await runInTenantContext(tenantId, async (tx) => {
    const b = await lockBooking(tx, tenantId, input.bookingId);
    if (!b || b.bookedByUserId !== input.userId) throw new BookingNotFoundForPlayersError();
    const r = await tx.openGameRequest.findFirst({
      where: { id: input.requestId, tenantId, game: { bookingId: b.id } },
      select: { id: true, userId: true, status: true, gameId: true },
    });
    if (!r) throw requestNotFound();

    // Repeating the answer already given is not an error.
    if (input.decision === 'accept' && r.status === 'ACCEPTED') return false;
    if (input.decision === 'decline' && r.status === 'DECLINED') return false;
    if (r.status !== 'PENDING') {
      throw new OpenPlayError('REQUEST_NOT_PENDING', 409, 'That request is no longer waiting.');
    }
    if (!playerMayCancel(b.startTs, b.cutoffHours, now)) throw cutoffPassed();

    if (input.decision === 'decline') {
      await tx.openGameRequest.updateMany({
        where: { id: r.id, tenantId, status: 'PENDING' },
        data: { status: 'DECLINED', decidedAt: now },
      });
      await appendAuditEntry(tx, {
        tenantId,
        actorUserId: input.userId,
        entity: 'OpenGameRequest',
        entityId: r.id,
        action: AUDIT_ACTIONS.OPEN_PLAY_DECLINED,
        details: `Declined a request to join booking ${b.id}`,
        detailsJson: { category: 'booking', bookingId: b.id, requestUserId: r.userId },
      });
      return true;
    }

    if (b.status !== 'CONFIRMED') throw gameClosed();
    await acceptInto(tx, b, r, { actorUserId: input.userId, now });
    return true;
  });

  if (changed) {
    await notifyOpenPlay({
      tenantId,
      requestId: input.requestId,
      event: input.decision === 'accept' ? 'accepted' : 'declined',
    });
  }

  const view = await getBookingGame({ userId: input.userId, bookingId: input.bookingId, now });
  if (!view) throw new BookingNotFoundForPlayersError();
  return view;
}

async function acceptInto(
  tx: PrismaClient,
  b: LockedBooking,
  r: { id: string; userId: string; gameId: string },
  opts: { actorUserId: string; now: Date },
): Promise<void> {
  const game = await tx.openGame.findFirst({
    where: { id: r.gameId, tenantId: b.tenantId },
    select: { spotsWanted: true },
  });
  if (!game) throw requestNotFound();
  const accepted = await tx.openGameRequest.count({
    where: { tenantId: b.tenantId, gameId: r.gameId, status: 'ACCEPTED' },
  });
  const left = spotsLeftOf({
    spotsWanted: game.spotsWanted,
    accepted,
    capacity: b.capacity,
    participants: b.participants.length,
  });
  const alreadyOn = b.participants.find((p) => p.userId === r.userId);
  if (left <= 0 && !alreadyOn) throw gameFull();

  await requirePlayerAccount(tx, r.userId);
  let participantId = alreadyOn?.id ?? null;
  if (!participantId) {
    const added = await insertParticipant(tx, b, r.userId);
    participantId = added.participantId;
  }
  if (!participantId) throw gameFull();

  await tx.openGameRequest.updateMany({
    where: { id: r.id, tenantId: b.tenantId, status: 'PENDING' },
    data: { status: 'ACCEPTED', participantId, decidedAt: opts.now },
  });
  await appendAuditEntry(tx, {
    tenantId: b.tenantId,
    actorUserId: opts.actorUserId,
    entity: 'BookingParticipant',
    entityId: participantId,
    action: AUDIT_ACTIONS.BOOKING_PLAYER_JOINED,
    details: `Accepted into booking ${b.id} through open play`,
    detailsJson: { category: 'booking', bookingId: b.id, via: 'open_play', requestId: r.id },
  });
}

// ─── The asker's side ───────────────────────────────────────────────────

/**
 * Ask to join a game, with an optional note to the booker. Asking again after
 * withdrawing, leaving, a lapse or a close is allowed; after the booker
 * declined or removed the player, it is not.
 *
 * A player the club has blocked from booking online for no-shows (#354) is
 * refused here too: joining puts them on a booking at that club.
 */
export async function askToJoin(input: {
  userId: string;
  gameId: string;
  note?: string | null;
  now?: Date;
}): Promise<{ game: OpenGameSummary; created: boolean }> {
  const now = input.now ?? new Date();
  const note = cleanNote(input.note);
  if (!(await isLivePlayer(input.userId))) {
    // The precise reason (no kind chosen yet, or a club/coach account).
    await runAsSuperuser((db) => requirePlayerAccount(db, input.userId));
    throw new OpenPlayError(
      'PLAYER_ACCOUNT_REQUIRED',
      403,
      'Joining a game needs a player account.',
    );
  }

  // guardrail-allow: cross-tenant — which club a game id is at, before any
  // club is bound; the id came from the public listing.
  const where = await runAsSuperuser(async (db) => {
    const g = await db.openGame.findUnique({
      where: { id: input.gameId },
      select: { tenantId: true, bookingId: true, booking: { select: { bookedByUserId: true } } },
    });
    if (!g) return null;
    const blocked = g.booking.bookedByUserId
      ? (await blockedEitherWay(db, input.userId)).includes(g.booking.bookedByUserId)
      : false;
    return blocked ? null : g;
  });
  if (!where) throw gameNotFound();

  if (!isRateLimitBypassed()) {
    const r = await checkRateLimit(`open-play-ask:u:${input.userId}`, OPEN_PLAY_ASK_LIMIT);
    if (!r.allowed) throw new RateLimitedError('Too many requests to join. Try again later.');
  }

  const requestId = await runInTenantContext(where.tenantId, async (tx) => {
    const b = await lockBooking(tx, where.tenantId, where.bookingId);
    const game = await tx.openGame.findFirst({
      where: { id: input.gameId, tenantId: where.tenantId },
      select: { id: true, spotsWanted: true, closedAt: true },
    });
    if (!b || !game) throw gameNotFound();
    if (
      b.bookedByUserId === input.userId ||
      b.participants.some((p) => p.userId === input.userId)
    ) {
      throw new OpenPlayError('ALREADY_PLAYING', 409, 'You are already playing in this game.');
    }
    if (game.closedAt || b.status !== 'CONFIRMED') throw gameClosed();
    if (!playerMayCancel(b.startTs, b.cutoffHours, now)) throw cutoffPassed();

    const prior = await tx.openGameRequest.findUnique({
      where: { gameId_userId: { gameId: game.id, userId: input.userId } },
      select: { id: true, status: true },
    });
    if (prior?.status === 'PENDING') return { id: prior.id, fresh: false };
    if (prior?.status === 'DECLINED' || prior?.status === 'REMOVED') {
      throw new OpenPlayError('ASK_DECLINED', 409, 'The booker has said no to you for this game.');
    }

    const accepted = await tx.openGameRequest.count({
      where: { tenantId: where.tenantId, gameId: game.id, status: 'ACCEPTED' },
    });
    const left = spotsLeftOf({
      spotsWanted: game.spotsWanted,
      accepted,
      capacity: b.capacity,
      participants: b.participants.length,
    });
    if (left <= 0) throw gameFull();
    await assertMayBookOnline(tx, where.tenantId, input.userId, now);

    const row = prior
      ? await tx.openGameRequest.update({
          where: { id: prior.id },
          data: { status: 'PENDING', note, askedAt: now, decidedAt: null, participantId: null },
          select: { id: true },
        })
      : await tx.openGameRequest.create({
          data: {
            tenantId: where.tenantId,
            gameId: game.id,
            userId: input.userId,
            note,
            askedAt: now,
          },
          select: { id: true },
        });
    await appendAuditEntry(tx, {
      tenantId: where.tenantId,
      actorUserId: input.userId,
      entity: 'OpenGameRequest',
      entityId: row.id,
      action: AUDIT_ACTIONS.OPEN_PLAY_REQUESTED,
      details: `Asked to join booking ${b.id}`,
      detailsJson: { category: 'booking', bookingId: b.id, hasNote: note !== null },
    });
    return { id: row.id, fresh: true };
  });

  if (requestId.fresh) {
    await notifyOpenPlay({ tenantId: where.tenantId, requestId: requestId.id, event: 'requested' });
  }
  const game = await getOpenGame(input.gameId, { viewerId: input.userId, now });
  if (!game) throw gameNotFound();
  return { game, created: requestId.fresh };
}

/**
 * Take back one's own request: a waiting one is withdrawn; an accepted one
 * means leaving the game, which is `leaveBooking` (until the cutoff, rule 2).
 */
export async function withdrawMyRequest(input: {
  userId: string;
  requestId: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  // guardrail-allow: cross-tenant — the caller's own request, by its id and
  // their user id, at whichever club.
  const r = await runAsSuperuser((db) =>
    db.openGameRequest.findFirst({
      where: { id: input.requestId, userId: input.userId },
      select: {
        id: true,
        tenantId: true,
        status: true,
        game: { select: { bookingId: true } },
      },
    }),
  );
  if (!r) throw requestNotFound();
  if (r.status === 'ACCEPTED') {
    await leaveBooking({ userId: input.userId, bookingId: r.game.bookingId, now });
    return;
  }
  if (r.status === 'WITHDRAWN') return;
  if (r.status !== 'PENDING') {
    throw new OpenPlayError('REQUEST_NOT_PENDING', 409, 'That request is no longer waiting.');
  }

  await runInTenantContext(r.tenantId, async (tx) => {
    const { count } = await tx.openGameRequest.updateMany({
      where: { id: r.id, tenantId: r.tenantId, userId: input.userId, status: 'PENDING' },
      data: { status: 'WITHDRAWN', decidedAt: now },
    });
    if (count === 0) {
      throw new OpenPlayError('REQUEST_NOT_PENDING', 409, 'That request is no longer waiting.');
    }
    await appendAuditEntry(tx, {
      tenantId: r.tenantId,
      actorUserId: input.userId,
      entity: 'OpenGameRequest',
      entityId: r.id,
      action: AUDIT_ACTIONS.OPEN_PLAY_WITHDRAWN,
      details: `Withdrew a request to join booking ${r.game.bookingId}`,
      detailsJson: { category: 'booking', bookingId: r.game.bookingId },
    });
  });
}

export interface MyGameRequest {
  id: string;
  status: OpenGameRequestStatus;
  note: string | null;
  askedAt: Date;
  decidedAt: Date | null;
  /** The booking, once accepted: the player's own booking page then. */
  bookingId: string | null;
  game: OpenGameSummary;
}

/**
 * "Моите заявки": the caller's requests for games still to come or started
 * in the last week, newest ask first, each with its state as of now.
 */
export async function listMyGameRequests(input: {
  userId: string;
  now?: Date;
}): Promise<MyGameRequest[]> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - MY_REQUESTS_PAST_DAYS * DAY_MS);
  // guardrail-allow: cross-tenant — the caller's own requests at every club,
  // by their user id.
  return runAsSuperuser(async (db) => {
    const rows = await db.openGameRequest.findMany({
      where: { userId: input.userId, game: { booking: { startTs: { gt: since } } } },
      select: {
        id: true,
        status: true,
        note: true,
        askedAt: true,
        decidedAt: true,
        game: { select: GAME_SELECT },
      },
      orderBy: [{ askedAt: 'desc' }, { id: 'desc' }],
      take: MY_REQUESTS_LIMIT,
    });
    const games = await summarise(
      db,
      rows.map((r) => r.game),
      input.userId,
      now,
    );
    return rows.flatMap((r, i): MyGameRequest[] => {
      const game = games[i];
      if (!game) return [];
      const status = effectiveStatus(
        r.status,
        r.game.booking.startTs,
        r.game.booking.resource.venue.cancellationCutoffHours,
        now,
      );
      return [
        {
          id: r.id,
          status,
          note: r.note,
          askedAt: r.askedAt,
          decidedAt: r.decidedAt,
          bookingId: status === 'ACCEPTED' ? r.game.booking.id : null,
          game,
        },
      ];
    });
  });
}

// ─── The lapse sweep (rule 4) ───────────────────────────────────────────

export const LAPSE_BATCH = 500;

/**
 * Every request still waiting at its club's cutoff lapses, and its asker is
 * told. Claimed by one UPDATE … RETURNING over `FOR UPDATE SKIP LOCKED`, so
 * two overlapping runs never lapse (or tell) one request twice, and a booker's
 * answer that committed first wins: the UPDATE requires PENDING still.
 *
 * Run by the booking-reminders cron (every 5 minutes), so a player hears
 * within minutes; every read already shows the request as lapsed.
 */
export async function lapseOpenPlayRequests(
  opts: { now?: Date } = {},
): Promise<{ lapsed: number }> {
  const now = opts.now ?? new Date();
  // guardrail-allow: cross-tenant — the sweep runs for every club at once, as
  // the reminders and completion sweeps do; it touches PENDING rows only.
  const claimed = await runAsSuperuser(
    (db) =>
      db.$queryRaw<Array<{ id: string; tenantId: string }>>`
      UPDATE "open_game_request" SET status = 'LAPSED', "decidedAt" = ${now}, "updatedAt" = ${now}
       WHERE id IN (
         SELECT q.id
           FROM "open_game_request" q
           JOIN "open_game" g ON g.id = q."gameId"
           JOIN "booking" b ON b.id = g."bookingId"
           JOIN "court" r ON r.id = b."resourceId"
           JOIN "venue" v ON v.id = r."venueId"
          WHERE q.status = 'PENDING'
            AND b."startTs" - make_interval(hours => v."cancellationCutoffHours") < ${now}
          ORDER BY q."askedAt"
          LIMIT ${LAPSE_BATCH}
          FOR UPDATE OF q SKIP LOCKED
       )
         AND status = 'PENDING'
   RETURNING id, "tenantId"`,
  );
  for (const c of claimed) {
    await notifyOpenPlay({ tenantId: c.tenantId, requestId: c.id, event: 'lapsed' });
  }
  return { lapsed: claimed.length };
}
