import type { PrismaClient, ResultStatus, SportType } from '@prisma/client';

import { bookingPlayerIds, locate } from '@/app-layer/usecases/booking-players';
import { recordMatch } from '@/app-layer/usecases/ratings';
import { matchPlayedFromBooking, tournamentMatchRules } from '@/app-layer/usecases/tournament-draw';
import { runAsSuperuser, runInTenantContext } from '@/lib/db/rls-middleware';
import { InvalidScoreError, scoreFormatFor, winnerOf, type ScoreFormat } from '@/lib/ranking/score';
import { SPORTS } from '@/lib/sports/registry';

/**
 * THE RESULT OF A BOOKING: REPORTED, ANSWERED, DECIDED (#575; owner decisions
 * 29–48 on #378).
 *
 *   a player on a completed booking reports it, within 7 days of its end (29,
 *   45): the sides from the booking's players (30) and the score (46)
 *       → REPORTED, and the other side is told (RESULT_REPORTED)
 *   a player on the OTHER side confirms                 → CONFIRMED, counted
 *   …or rejects, with a note                            → REJECTED, and the
 *                                                         club is told (34)
 *   nobody answers within 48 h (Q23)                    → CONFIRMED, counted
 *   the club confirms a version, or voids it            → DECIDED (counted)
 *                                                         or VOIDED
 *   the club enters a result itself                     → DECIDED: final
 *                                                         (the default taken
 *                                                         in round 4)
 *
 * "Counted" is `recordMatch`: written once to match_result and the ratings
 * moved, idempotent by the booking (`booking:<id>`), so a confirm and the
 * 48-hour sweep racing each other rate the match once.
 *
 * A result is a club's row (P78): every write here runs in the booking's
 * club. Counting reads each player's declared level (owner-only rows), so it
 * runs as app_superuser, as rating always has.
 */

export const RESULT_REPORT_WINDOW_DAYS = 7;
export const RESULT_ANSWER_HOURS = 48;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const REJECT_NOTE_MAX = 500;

// ─── Errors ──────────────────────────────────────────────────────────────

/** No result can be reported for this booking now; `reason` says which rule. */
export class ResultNotReportableError extends Error {
  constructor(
    readonly reason: 'not-completed' | 'window-passed' | 'no-score' | 'not-a-player' | 'not-a-race',
  ) {
    super(
      reason === 'not-completed'
        ? 'Only a completed booking has a result.'
        : reason === 'window-passed'
          ? `A result is reported within ${RESULT_REPORT_WINDOW_DAYS} days of the booking.`
          : reason === 'no-score'
            ? 'This sport has no score to report.'
            : reason === 'not-a-race'
              ? 'A finishing order is for a race: karting.'
              : 'Only a player on the booking reports its result.',
    );
    this.name = 'ResultNotReportableError';
  }
}

export class ResultAlreadyReportedError extends Error {
  constructor() {
    super('This booking already has a result.');
    this.name = 'ResultAlreadyReportedError';
  }
}

export class ResultSidesError extends Error {
  constructor(readonly reason: string) {
    super(`Those sides cannot be right: ${reason}.`);
    this.name = 'ResultSidesError';
  }
}

/** A finishing order that cannot be right (#577). */
export class ResultOrderError extends Error {
  constructor(readonly reason: string) {
    super(`That finishing order cannot be right: ${reason}.`);
    this.name = 'ResultOrderError';
  }
}

export class ResultNotFoundError extends Error {
  constructor() {
    super('Result not found.');
    this.name = 'ResultNotFoundError';
  }
}

/** The caller is not on the side that answers this result. */
export class ResultNotYoursToAnswerError extends Error {
  constructor() {
    super('Only a player on the other side answers a result.');
    this.name = 'ResultNotYoursToAnswerError';
  }
}

/** The result is not waiting for this step any more. */
export class ResultNotAwaitingError extends Error {
  constructor() {
    super('This result is not waiting for that any more.');
    this.name = 'ResultNotAwaitingError';
  }
}

// ─── Shapes ──────────────────────────────────────────────────────────────

export interface ResultPlayer {
  userId: string;
  /** Null for a deleted account, or one with no name. */
  name: string | null;
  /** The account was deleted (#582): shown as «Изтрит потребител». */
  deleted: boolean;
}

export interface ResultView {
  id: string;
  status: ResultStatus;
  sides: ResultPlayer[][];
  score: number[][] | null;
  winnerSide: number | null;
  reportedByMe: boolean;
  reportedAt: string;
  /** When a REPORTED result confirms itself. */
  autoConfirmAt: string | null;
  /** The caller is on the other side and it waits for them. */
  canAnswer: boolean;
}

export interface BookingResultState {
  result: ResultView | null;
  /** The caller may report it now. */
  canReport: boolean;
  /** The last moment it can be reported, while it can. */
  reportableUntil: string | null;
  /** How the sport's score is entered (`@/lib/ranking/score`). */
  format: ScoreFormat;
  /** The booking's players, for picking the sides. */
  players: ResultPlayer[];
  /**
   * The sides a tournament's draw set (#580), when the booking is a
   * tournament match: the result keeps them, and the form does not ask.
   */
  fixedSides: ResultPlayer[][] | null;
}

// ─── Reading a booking for a result ─────────────────────────────────────

interface BookingForResult {
  id: string;
  tenantId: string;
  status: string;
  endTs: Date;
  sport: SportType;
  players: string[];
}

async function bookingForResult(
  tenantId: string,
  bookingId: string,
): Promise<BookingForResult | null> {
  return runInTenantContext(tenantId, async (db) => {
    const b = await db.booking.findFirst({
      where: { id: bookingId, tenantId },
      select: {
        id: true,
        tenantId: true,
        status: true,
        endTs: true,
        bookedByUserId: true,
        participants: { select: { userId: true, position: true } },
        resource: { select: { sport: true } },
      },
    });
    if (!b) return null;
    return {
      id: b.id,
      tenantId: b.tenantId,
      status: b.status,
      endTs: b.endTs,
      sport: b.resource.sport,
      players: bookingPlayerIds(b),
    };
  });
}

/**
 * The people on bookings' results, by id: their names, which every player on
 * a booking already sees in its list of players, and whether the account is
 * gone. An id with no account reads as deleted.
 */
async function peopleOf(ids: readonly string[]): Promise<(id: string) => ResultPlayer> {
  const unique = [...new Set(ids)];
  // guardrail-allow: cross-tenant — the names of the people on bookings'
  // results, whom every player on each booking already sees.
  const rows = unique.length
    ? await runAsSuperuser((db) =>
        db.user.findMany({
          where: { id: { in: unique } },
          select: { id: true, name: true, deletedAt: true },
          take: unique.length,
        }),
      )
    : [];
  const byId = new Map(rows.map((u) => [u.id, u]));
  return (id) => {
    const u = byId.get(id);
    const gone = !u || !!u.deletedAt;
    return { userId: id, name: gone ? null : (u?.name ?? null), deleted: gone };
  };
}

function sidesOf(json: unknown): string[][] {
  return Array.isArray(json)
    ? json.map((side) =>
        Array.isArray(side) ? side.filter((x): x is string => typeof x === 'string') : [],
      )
    : [];
}

function reportableUntil(b: { endTs: Date }): Date {
  return new Date(b.endTs.getTime() + RESULT_REPORT_WINDOW_DAYS * DAY_MS);
}

function sideOf(sides: string[][], userId: string): number {
  return sides.findIndex((s) => s.includes(userId));
}

// ─── The player's side ──────────────────────────────────────────────────

/**
 * Where a booking's result stands for the caller: the result if there is one,
 * whether they may report or answer, and the players to pick sides from.
 * Null for a booking that is not theirs (the route's 404).
 */
export async function readBookingResult(
  userId: string,
  bookingId: string,
  now = new Date(),
): Promise<BookingResultState | null> {
  const at = await locate(userId, bookingId);
  if (!at) return null;
  const b = await bookingForResult(at.tenantId, bookingId);
  if (!b) return null;

  const report = await runInTenantContext(at.tenantId, (db) =>
    db.matchReport.findUnique({ where: { bookingId } }),
  );
  const ids = new Set(b.players);
  for (const side of sidesOf(report?.sidesJson)) for (const id of side) ids.add(id);
  const player = await peopleOf([...ids]);

  const format = scoreFormatFor(b.sport);
  const until = reportableUntil(b);
  const canReport =
    !report &&
    b.status === 'COMPLETED' &&
    now < until &&
    (format === 'PERIODS' || format === 'TOTAL') &&
    b.players.includes(userId);

  let result: ResultView | null = null;
  if (report) {
    const sides = sidesOf(report.sidesJson);
    const reporterSide = sideOf(sides, report.reportedByUserId);
    const mySide = sideOf(sides, userId);
    result = {
      id: report.id,
      status: report.status,
      sides: sides.map((s) => s.map(player)),
      score: Array.isArray(report.scoreJson) ? (report.scoreJson as number[][]) : null,
      winnerSide: report.winnerSide,
      reportedByMe: report.reportedByUserId === userId,
      reportedAt: report.reportedAt.toISOString(),
      autoConfirmAt: report.autoConfirmAt?.toISOString() ?? null,
      canAnswer: report.status === 'REPORTED' && mySide >= 0 && mySide !== reporterSide,
    };
  }

  const rules = await runInTenantContext(at.tenantId, (db) =>
    tournamentMatchRules(db, at.tenantId, bookingId),
  );
  return {
    result,
    canReport,
    reportableUntil: canReport ? until.toISOString() : null,
    format,
    players: b.players.map(player),
    fixedSides: rules ? rules.sides.map((s) => s.map(player)) : null,
  };
}

/** Check the sides against the booking's players; the reporter is on one. */
function checkSides(
  sport: SportType,
  sides: unknown,
  players: readonly string[],
  reporter: string,
): string[][] {
  if (!Array.isArray(sides) || sides.length !== 2)
    throw new ResultSidesError('there are two sides');
  const clean = sides.map((s) => {
    if (!Array.isArray(s) || s.length === 0) throw new ResultSidesError('each side has a player');
    return s.map((id) => {
      if (typeof id !== 'string' || !players.includes(id)) {
        throw new ResultSidesError('everyone on a side played the booking');
      }
      return id;
    });
  });
  const all = clean.flat();
  if (new Set(all).size !== all.length) throw new ResultSidesError('nobody plays on both sides');
  if (!all.includes(reporter)) throw new ResultSidesError('the reporter is on a side');
  const perSide = SPORTS[sport].teamSize.perSide;
  if (perSide && clean.some((s) => s.length > perSide)) {
    throw new ResultSidesError(`at most ${perSide} a side`);
  }
  return clean;
}

export interface ReportInput {
  sides: string[][];
  score: number[][];
}

/**
 * A player reports the result of their booking. Answers the result as stored;
 * the caller tells the other side (`notifyResultReported`) after it commits.
 */
export async function reportResult(
  userId: string,
  bookingId: string,
  input: ReportInput,
  now = new Date(),
): Promise<{ reportId: string; tenantId: string }> {
  const at = await locate(userId, bookingId);
  if (!at) throw new ResultNotFoundError();
  const b = await bookingForResult(at.tenantId, bookingId);
  if (!b) throw new ResultNotFoundError();
  if (b.status !== 'COMPLETED') throw new ResultNotReportableError('not-completed');
  if (now >= reportableUntil(b)) throw new ResultNotReportableError('window-passed');
  const format = scoreFormatFor(b.sport);
  if (format !== 'PERIODS' && format !== 'TOTAL') throw new ResultNotReportableError('no-score');
  if (!b.players.includes(userId)) throw new ResultNotReportableError('not-a-player');

  const sides = checkSides(b.sport, input.sides, b.players, userId);
  const winnerSide = winnerOf(b.sport, input.score);
  await checkTournamentMatch(at.tenantId, bookingId, sides, winnerSide);

  try {
    const row = await runInTenantContext(at.tenantId, (db) =>
      db.matchReport.create({
        data: {
          tenantId: at.tenantId,
          bookingId,
          sport: b.sport,
          kind: 'SCORE',
          sidesJson: sides,
          scoreJson: input.score,
          winnerSide,
          reportedByUserId: userId,
          reportedAt: now,
          autoConfirmAt: new Date(now.getTime() + RESULT_ANSWER_HOURS * HOUR_MS),
        },
        select: { id: true },
      }),
    );
    return { reportId: row.id, tenantId: at.tenantId };
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new ResultAlreadyReportedError();
    throw err;
  }
}

/**
 * A player on the other side confirms or rejects. A confirmation counts the
 * result; a rejection waits for the club. Answers the new status and, for the
 * notices, which club.
 */
export async function answerResult(
  userId: string,
  reportId: string,
  answer: { action: 'confirm' } | { action: 'reject'; note?: string | null },
  now = new Date(),
): Promise<{ status: ResultStatus; tenantId: string; bookingId: string }> {
  // guardrail-allow: cross-tenant — one result by its id, to find its club;
  // nothing is read from it before the caller is matched to its sides below.
  const found = await runAsSuperuser((db) =>
    db.matchReport.findUnique({
      where: { id: reportId },
      select: {
        tenantId: true,
        bookingId: true,
        sidesJson: true,
        reportedByUserId: true,
        status: true,
      },
    }),
  );
  if (!found) throw new ResultNotFoundError();
  const sides = sidesOf(found.sidesJson);
  const mine = sideOf(sides, userId);
  if (mine < 0) throw new ResultNotFoundError();
  if (mine === sideOf(sides, found.reportedByUserId)) throw new ResultNotYoursToAnswerError();

  const status: ResultStatus = answer.action === 'confirm' ? 'CONFIRMED' : 'REJECTED';
  const note =
    answer.action === 'reject' && answer.note
      ? answer.note.trim().slice(0, REJECT_NOTE_MAX) || null
      : null;
  const changed = await runInTenantContext(found.tenantId, (db) =>
    db.matchReport.updateMany({
      where: { id: reportId, status: 'REPORTED' },
      data: { status, answeredByUserId: userId, answeredAt: now, rejectNote: note },
    }),
  );
  if (changed.count !== 1) throw new ResultNotAwaitingError();
  if (status === 'CONFIRMED') await countResult(found.tenantId, reportId);
  return { status, tenantId: found.tenantId, bookingId: found.bookingId };
}

/**
 * The 48-hour rule (Q23): every result still REPORTED past its time confirms
 * itself and counts. Answers how many. Run by the cron.
 */
export async function confirmDueResults(now = new Date(), limit = 200): Promise<number> {
  // guardrail-allow: cross-tenant — the sweep: every club's results past their
  // answer time, by an index on (status, autoConfirmAt). Nothing else is read.
  const due = await runAsSuperuser((db) =>
    db.matchReport.findMany({
      where: { status: 'REPORTED', autoConfirmAt: { lte: now } },
      select: { id: true, tenantId: true },
      orderBy: { autoConfirmAt: 'asc' },
      take: limit,
    }),
  );
  let confirmed = 0;
  for (const r of due) {
    const changed = await runInTenantContext(r.tenantId, (db) =>
      db.matchReport.updateMany({
        where: { id: r.id, status: 'REPORTED' },
        data: { status: 'CONFIRMED', answeredAt: now },
      }),
    );
    if (changed.count === 1) {
      await countResult(r.tenantId, r.id);
      confirmed++;
    }
  }
  return confirmed;
}

// ─── The club's side ────────────────────────────────────────────────────

export interface ClubResultRow {
  id: string;
  bookingId: string;
  status: ResultStatus;
  sport: SportType;
  /** How its score is entered, for a correction. */
  format: ScoreFormat;
  startTs: string;
  courtName: string;
  sides: ResultPlayer[][];
  score: number[][] | null;
  winnerSide: number | null;
  rejectNote: string | null;
  reportedAt: string;
}

/** A club's results that wait for it (REJECTED), or every recent one. */
export async function listClubResults(
  db: PrismaClient,
  tenantId: string,
  opts: { status?: ResultStatus; bookingId?: string; limit?: number } = {},
): Promise<ClubResultRow[]> {
  const rows = await db.matchReport.findMany({
    where: {
      tenantId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.bookingId ? { bookingId: opts.bookingId } : {}),
    },
    orderBy: { reportedAt: 'desc' },
    take: Math.min(opts.limit ?? 50, 100),
    select: {
      id: true,
      bookingId: true,
      status: true,
      sport: true,
      sidesJson: true,
      scoreJson: true,
      winnerSide: true,
      rejectNote: true,
      reportedAt: true,
      booking: { select: { startTs: true, resource: { select: { name: true } } } },
    },
  });
  const person = await peopleOf(rows.flatMap((r) => sidesOf(r.sidesJson).flat()));
  return rows.map((r) => ({
    id: r.id,
    bookingId: r.bookingId,
    status: r.status,
    sport: r.sport,
    format: scoreFormatFor(r.sport),
    startTs: r.booking.startTs.toISOString(),
    courtName: r.booking.resource.name,
    sides: sidesOf(r.sidesJson).map((s) => s.map(person)),
    score: Array.isArray(r.scoreJson) ? (r.scoreJson as number[][]) : null,
    winnerSide: r.winnerSide,
    rejectNote: r.rejectNote,
    reportedAt: r.reportedAt.toISOString(),
  }));
}

export interface ClubBookingResultState {
  result: ClubResultRow | null;
  /** The club may enter it now: completed, no result yet, a sport with a score. */
  canEnter: boolean;
  format: ScoreFormat;
  players: ResultPlayer[];
  /** A tournament match's sides, set by the draw (#580). */
  fixedSides: ResultPlayer[][] | null;
}

/**
 * One booking's result for the club's desk (#575): what the diary shows, and
 * whether the club may enter it itself. Null for another club's booking.
 */
export async function readClubBookingResult(
  tenantId: string,
  bookingId: string,
): Promise<ClubBookingResultState | null> {
  const b = await bookingForResult(tenantId, bookingId);
  if (!b) return null;
  const report = await runInTenantContext(tenantId, (db) =>
    db.matchReport.findUnique({ where: { bookingId }, select: { id: true } }),
  );
  const result = report
    ? ((
        await runInTenantContext(tenantId, (db) => listClubResults(db, tenantId, { bookingId }))
      )[0] ?? null)
    : null;
  const person = await peopleOf(b.players);
  const format = scoreFormatFor(b.sport);
  // A tournament match (#580): the draw's sides, all of them the booking's players.
  const rules = await runInTenantContext(tenantId, (db) =>
    tournamentMatchRules(db, tenantId, bookingId),
  );
  return {
    result,
    canEnter:
      !report &&
      b.status === 'COMPLETED' &&
      (format === 'PERIODS' || format === 'TOTAL' || (format === 'ORDER' && b.players.length >= 2)),
    format,
    players: b.players.map(person),
    fixedSides: rules ? rules.sides.map((side) => side.map(person)) : null,
  };
}

/**
 * The club decides a result that is not counted yet (decision 34): confirms it
 * as reported, confirms a corrected version, or voids it. Answers the new
 * status; the caller tells the players.
 */
export async function decideResult(
  actor: { userId: string; tenantId: string },
  reportId: string,
  decision: { action: 'confirm'; sides?: string[][]; score?: number[][] } | { action: 'void' },
  now = new Date(),
): Promise<{ status: ResultStatus; bookingId: string }> {
  const report = await runInTenantContext(actor.tenantId, (db) =>
    db.matchReport.findFirst({
      where: { id: reportId, tenantId: actor.tenantId },
      select: {
        bookingId: true,
        status: true,
        sport: true,
        sidesJson: true,
        reportedByUserId: true,
      },
    }),
  );
  if (!report) throw new ResultNotFoundError();
  if (report.status !== 'REPORTED' && report.status !== 'REJECTED')
    throw new ResultNotAwaitingError();

  let data: Parameters<PrismaClient['matchReport']['updateMany']>[0]['data'];
  if (decision.action === 'void') {
    data = { status: 'VOIDED', decidedByUserId: actor.userId, decidedAt: now };
  } else {
    let sidesJson: string[][] | undefined;
    let scoreJson: number[][] | undefined;
    let winnerSide: number | null | undefined;
    if (decision.sides || decision.score) {
      const b = await bookingForResult(actor.tenantId, report.bookingId);
      if (!b) throw new ResultNotFoundError();
      const sides = decision.sides ?? sidesOf(report.sidesJson);
      // The club corrects; it need not be on a side, so the reporter stands in.
      sidesJson = checkSides(b.sport, sides, b.players, sides.flat()[0] ?? report.reportedByUserId);
      if (decision.score) {
        scoreJson = decision.score;
        winnerSide = winnerOf(b.sport, decision.score);
      }
      await checkTournamentMatch(
        actor.tenantId,
        report.bookingId,
        sidesJson,
        winnerSide === undefined ? 0 : winnerSide,
      );
    }
    data = {
      status: 'DECIDED',
      decidedByUserId: actor.userId,
      decidedAt: now,
      ...(sidesJson ? { sidesJson } : {}),
      ...(scoreJson ? { scoreJson, winnerSide } : {}),
    };
  }
  const changed = await runInTenantContext(actor.tenantId, (db) =>
    db.matchReport.updateMany({
      where: { id: reportId, tenantId: actor.tenantId, status: { in: ['REPORTED', 'REJECTED'] } },
      data,
    }),
  );
  if (changed.count !== 1) throw new ResultNotAwaitingError();
  if (decision.action === 'confirm') await countResult(actor.tenantId, reportId);
  return { status: decision.action === 'void' ? 'VOIDED' : 'DECIDED', bookingId: report.bookingId };
}

/**
 * The club enters a booking's result itself: final, counted at once (the
 * default taken in round 4 of #378). For a booking with no result yet.
 */
export async function enterClubResult(
  actor: { userId: string; tenantId: string },
  bookingId: string,
  input: ReportInput,
  now = new Date(),
): Promise<{ reportId: string }> {
  const b = await bookingForResult(actor.tenantId, bookingId);
  if (!b) throw new ResultNotFoundError();
  if (b.status !== 'COMPLETED') throw new ResultNotReportableError('not-completed');
  const format = scoreFormatFor(b.sport);
  if (format !== 'PERIODS' && format !== 'TOTAL') throw new ResultNotReportableError('no-score');
  const reporter = (input.sides ?? []).flat()[0];
  const sides = checkSides(
    b.sport,
    input.sides,
    b.players,
    typeof reporter === 'string' ? reporter : '',
  );
  const winnerSide = winnerOf(b.sport, input.score);
  await checkTournamentMatch(actor.tenantId, bookingId, sides, winnerSide);
  try {
    const row = await runInTenantContext(actor.tenantId, (db) =>
      db.matchReport.create({
        data: {
          tenantId: actor.tenantId,
          bookingId,
          sport: b.sport,
          kind: 'SCORE',
          sidesJson: sides,
          scoreJson: input.score,
          winnerSide,
          status: 'DECIDED',
          // The club's staff member is who reported it, as the row says who decided.
          reportedByUserId: actor.userId,
          reportedAt: now,
          decidedByUserId: actor.userId,
          decidedAt: now,
        },
        select: { id: true },
      }),
    );
    await countResult(actor.tenantId, row.id);
    return { reportId: row.id };
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new ResultAlreadyReportedError();
    throw err;
  }
}

/**
 * A track's staff enter a session's finishing order from their timing system
 * (#577, decision 33): the drivers on the booking, first to last. No player
 * confirms it; it counts at once, as a race. A driver left out did not race.
 */
export async function enterClubOrder(
  actor: { userId: string; tenantId: string },
  bookingId: string,
  order: string[],
  now = new Date(),
): Promise<{ reportId: string }> {
  const b = await bookingForResult(actor.tenantId, bookingId);
  if (!b) throw new ResultNotFoundError();
  if (b.status !== 'COMPLETED') throw new ResultNotReportableError('not-completed');
  if (scoreFormatFor(b.sport) !== 'ORDER') throw new ResultNotReportableError('not-a-race');
  const drivers = checkOrder(order, b.players);
  try {
    const row = await runInTenantContext(actor.tenantId, (db) =>
      db.matchReport.create({
        data: {
          tenantId: actor.tenantId,
          bookingId,
          sport: b.sport,
          kind: 'ORDER',
          // One "side" a driver, in finishing order: the shape a race rates in.
          sidesJson: drivers.map((id) => [id]),
          status: 'DECIDED',
          reportedByUserId: actor.userId,
          reportedAt: now,
          decidedByUserId: actor.userId,
          decidedAt: now,
        },
        select: { id: true },
      }),
    );
    await countResult(actor.tenantId, row.id);
    return { reportId: row.id };
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new ResultAlreadyReportedError();
    throw err;
  }
}

/** Two drivers at least, each on the booking, each once. */
function checkOrder(order: unknown, players: readonly string[]): string[] {
  if (!Array.isArray(order) || order.length < 2)
    throw new ResultOrderError('a race has two drivers');
  const ids = order.map((id) => {
    if (typeof id !== 'string' || !players.includes(id)) {
      throw new ResultOrderError('every driver was on the booking');
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new ResultOrderError('each driver finishes once');
  return ids;
}

// ─── Counting ───────────────────────────────────────────────────────────

/**
 * Write a counted result to match_result and move the ratings: once, by the
 * booking. Rating reads every player's declared level and writes their
 * history, which are each player's own rows: app_user's grants cannot do it,
 * so this binds app_superuser, as rating has since the port.
 */
async function countResult(tenantId: string, reportId: string): Promise<void> {
  // guardrail-allow: cross-tenant — rating writes every player's history and
  // reads their declared level, rows owned by each player, not the club.
  await runAsSuperuser(async (db) => {
    const r = await db.matchReport.findUnique({
      where: { id: reportId },
      select: {
        bookingId: true,
        sport: true,
        kind: true,
        sidesJson: true,
        scoreJson: true,
        winnerSide: true,
        reportedByUserId: true,
        status: true,
      },
    });
    if (!r || (r.status !== 'CONFIRMED' && r.status !== 'DECIDED')) return;
    const sides = sidesOf(r.sidesJson);
    if (sides.length < 2) return;
    // Best-first, as recordMatch wants. A race is already in finishing order,
    // one driver a place (#577); a match is two sides, a draw equal ranks.
    const race = r.kind === 'ORDER';
    const teams = race
      ? sides
      : r.winnerSide === 1
        ? [sides[1]!, sides[0]!]
        : [sides[0]!, sides[1]!];
    const ranks = race ? sides.map((_, i) => i + 1) : r.winnerSide === null ? [1, 1] : [1, 2];
    const dedupeKey = `booking:${r.bookingId}`;
    await recordMatch(db, {
      tenantId,
      sport: r.sport,
      teams,
      ranks,
      reportedByUserId: r.reportedByUserId,
      dedupeKey,
    });
    const counted = await db.matchResultRecord.findUnique({
      where: { dedupeKey },
      select: { id: true },
    });
    if (counted) {
      await db.matchReport.updateMany({
        where: { id: reportId, matchResultId: null },
        data: { matchResultId: counted.id },
      });
    }
    // A tournament match's booking (#580): the match is played, and the draw
    // moves on. Nothing for any other booking.
    if (!race) {
      await matchPlayedFromBooking(
        db,
        { id: r.bookingId, tenantId },
        {
          sides,
          winnerSide: r.winnerSide,
          score: Array.isArray(r.scoreJson) ? (r.scoreJson as number[][]) : null,
        },
      );
    }
  });
}

/**
 * A tournament match's booking (#580): its result keeps the sides the draw set
 * (in either order), and a knockout's has a winner. Nothing for any other
 * booking.
 */
async function checkTournamentMatch(
  tenantId: string,
  bookingId: string,
  sides: readonly string[][],
  winnerSide: number | null,
): Promise<void> {
  const rules = await runInTenantContext(tenantId, (db) =>
    tournamentMatchRules(db, tenantId, bookingId),
  );
  if (!rules) return;
  const same = (x: readonly string[] | undefined, y: readonly string[] | undefined) =>
    !!x && !!y && x.length === y.length && x.every((id) => y.includes(id));
  const [a, b] = rules.sides;
  const kept = (same(sides[0], a) && same(sides[1], b)) || (same(sides[0], b) && same(sides[1], a));
  if (!kept) throw new ResultSidesError('the draw sets the sides');
  if (rules.knockout && winnerSide === null)
    throw new InvalidScoreError('a knockout match has a winner');
}
