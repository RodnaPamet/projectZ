import { randomInt } from 'node:crypto';

import type {
  Prisma,
  PrismaClient,
  SportType,
  TournamentFormatKind,
  TournamentMatchStatus,
  TournamentStage,
  TournamentStatus,
} from '@prisma/client';

import { cancelBooking, createBooking } from '@/app-layer/usecases/booking';
import { currentRating } from '@/app-layer/usecases/ratings';
import { runAsSuperuser, runInTenantContext } from '@/lib/db/rls-middleware';
import { AppError } from '@/lib/errors/types';
import {
  groupMatches,
  knockout,
  qualifiersInSeedOrder,
  seedEntries,
  snakeGroups,
  table,
  type DrawEntry,
  type MatchSpec,
  type PlayedMatch,
  type Random,
  type TableRow,
} from '@/lib/tournaments/draw';

/**
 * A CLUB TOURNAMENT'S DRAW, ITS MATCHES ON THE DIARY, AND HOW THEY MOVE ON
 * (#580; decisions 29, 40, 54, 55, 57, 59, 61 on #378).
 *
 *   the club makes the draw          REGISTRATION → IN_PROGRESS: every match
 *                                    written, byes sent on; the entries still
 *                                    waiting did not get in, and are declined
 *   the club puts a match on a court a booking, as any (40): it blocks the
 *                                    diary, its players are its participants,
 *                                    and they report its result as they would
 *                                    any booking's; or the club does
 *   the result counts                the match is PLAYED (rated, 29, as the
 *                                    booking's result is); the winner goes on,
 *                                    a semi-final's loser to third (61); the
 *                                    last group match draws the knockout from
 *                                    the tables (55, 57); the last match ends it
 *   the club records a walkover      the winner goes on, unplayed and unrated
 *   an entry withdraws mid-event     its played results stand; its other
 *                                    matches are walkovers to the opponents (59)
 *
 * Knockout, one round robin, and groups feeding a knockout. Americano and
 * Mexicano are #590, a league #591.
 *
 * Reading ratings for the seeds, and moving a draw on from a booking's
 * result, read and write rows that are not the club's (each player's rating,
 * their declared level): these bind app_superuser, with the club's tenantId
 * on every tournament query.
 */

export const DRAWN_FORMATS: readonly TournamentFormatKind[] = [
  'SINGLE_ELIMINATION',
  'ROUND_ROBIN',
  'GROUPS_KNOCKOUT',
];

export type TournamentDrawCode =
  | 'TOURNAMENT_DRAW_UNSUPPORTED'
  | 'TOURNAMENT_TOO_FEW'
  | 'TOURNAMENT_STATE'
  | 'TOURNAMENT_INVALID'
  | 'TOURNAMENT_MATCH_NOT_FOUND'
  | 'TOURNAMENT_MATCH_NOT_READY';

export class TournamentDrawError extends AppError {
  constructor(
    code: TournamentDrawCode,
    status: 400 | 404 | 409,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message, code, status, true, details);
    this.name = 'TournamentDrawError';
  }
}

const notFound = () =>
  new TournamentDrawError('TOURNAMENT_MATCH_NOT_FOUND', 404, 'Match not found.');

/** A cuid-shaped id, as `@default(cuid())` makes: the draw links matches before writing them. */
function newId(): string {
  let out = 'c';
  for (let i = 0; i < 24; i++) out += randomInt(36).toString(36);
  return out;
}

interface LockedTournament {
  id: string;
  tenantId: string;
  name: string;
  sport: SportType;
  format: TournamentFormatKind;
  status: TournamentStatus;
  teamSize: number;
  groupCount: number | null;
  qualifiersPerGroup: number | null;
  thirdPlace: boolean;
}

async function lock(db: PrismaClient, tenantId: string, id: string): Promise<LockedTournament> {
  const rows = await db.$queryRaw<LockedTournament[]>`
    SELECT "id", "tenantId", "name", "sport", "format", "status", "teamSize",
           "groupCount", "qualifiersPerGroup", "thirdPlace"
      FROM "tournament" WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const t = rows[0];
  if (!t) throw new TournamentDrawError('TOURNAMENT_STATE', 404, 'Tournament not found.');
  return t;
}

const playersOf = (e: { playerUserId: string; partnerUserId: string | null }) =>
  e.partnerUserId ? [e.playerUserId, e.partnerUserId] : [e.playerUserId];

// ─── Making the draw ────────────────────────────────────────────────────

export interface DrawOptions {
  /** Groups feeding a knockout (55): how many groups, how many go through from each. */
  groupCount?: number | null;
  qualifiersPerGroup?: number | null;
  /** A match for third place between the semi-final losers (61). */
  thirdPlace?: boolean;
}

/**
 * The club makes the draw: REGISTRATION → IN_PROGRESS. The confirmed entries
 * are seeded by their players' ratings in the sport, frozen now (54); the
 * entries still waiting did not get in, and are declined. Answers the
 * declined entries, for the caller to tell.
 */
export async function drawTournament(
  actor: { userId: string; tenantId: string },
  id: string,
  opts: DrawOptions,
  now: Date = new Date(),
  random: Random = Math.random,
): Promise<{ declined: string[] }> {
  // guardrail-allow: cross-tenant — the seeds read each player's own rating and
  // declared level; every tournament row is read and written by the club's tenantId.
  return runAsSuperuser(async (db) => {
    const t = await lock(db, actor.tenantId, id);
    if (t.status !== 'REGISTRATION') {
      throw new TournamentDrawError(
        'TOURNAMENT_STATE',
        409,
        'The draw is made once, from an open sign-up.',
      );
    }
    if (!DRAWN_FORMATS.includes(t.format)) {
      throw new TournamentDrawError(
        'TOURNAMENT_DRAW_UNSUPPORTED',
        409,
        'This format’s draw is not built yet: Americano and Mexicano (#590), a league (#591).',
      );
    }
    const entries = await db.tournamentEntry.findMany({
      where: { tenantId: actor.tenantId, tournamentId: id, status: 'CONFIRMED' },
      select: { id: true, playerUserId: true, partnerUserId: true },
      orderBy: { decidedAt: 'asc' },
      take: 512,
    });
    if (entries.length < 2) {
      throw new TournamentDrawError(
        'TOURNAMENT_TOO_FEW',
        409,
        'A draw needs two confirmed entries.',
      );
    }

    const groupCount = t.format === 'GROUPS_KNOCKOUT' ? (opts.groupCount ?? 2) : null;
    const qualifiers = t.format === 'GROUPS_KNOCKOUT' ? (opts.qualifiersPerGroup ?? 2) : null;
    if (groupCount !== null && qualifiers !== null) {
      if (!Number.isInteger(groupCount) || groupCount < 1 || groupCount * 2 > entries.length) {
        throw new TournamentDrawError(
          'TOURNAMENT_INVALID',
          400,
          'Each group needs two entries at least.',
          {
            field: 'groupCount',
          },
        );
      }
      const smallest = Math.floor(entries.length / groupCount);
      if (!Number.isInteger(qualifiers) || qualifiers < 1 || qualifiers > smallest) {
        throw new TournamentDrawError(
          'TOURNAMENT_INVALID',
          400,
          'More go through than a group holds.',
          {
            field: 'qualifiersPerGroup',
          },
        );
      }
    }
    const thirdPlace = t.format === 'ROUND_ROBIN' ? false : !!opts.thirdPlace;

    // The seeds (54): the mean of the entry's players' ratings, frozen now.
    const strengths: DrawEntry[] = [];
    for (const e of entries) {
      const ratings = await Promise.all(
        playersOf(e).map((u) => currentRating(db, u, t.sport, now)),
      );
      const mean = ratings.reduce((sum, r) => sum + r.state.mu, 0) / ratings.length;
      strengths.push({ id: e.id, strength: mean });
    }

    let specs: MatchSpec[];
    const groupOf = new Map<string, number>();
    const seedOf = new Map<string, number>();
    if (t.format === 'SINGLE_ELIMINATION') {
      const seeded = seedEntries(strengths, random);
      seeded.forEach((e, i) => seedOf.set(e.id, i + 1));
      specs = knockout(
        seeded.map((e) => e.id),
        { thirdPlace },
      );
    } else {
      const groups =
        t.format === 'ROUND_ROBIN'
          ? [strengths.map((e) => e.id)]
          : snakeGroups(strengths, groupCount!);
      groups.forEach((g, i) => g.forEach((entryId) => groupOf.set(entryId, i + 1)));
      [...strengths]
        .sort((a, b) => b.strength - a.strength)
        .forEach((e, i) => seedOf.set(e.id, i + 1));
      specs = groupMatches(groups);
    }

    await writeMatches(db, actor.tenantId, id, specs, now);

    for (const e of strengths) {
      await db.tournamentEntry.updateMany({
        where: { id: e.id, tenantId: actor.tenantId },
        data: {
          seed: seedOf.get(e.id) ?? null,
          groupNo: groupOf.get(e.id) ?? null,
          seedRating: Math.round(e.strength * 100),
        },
      });
    }
    // The entries still waiting did not get in: the draw is made.
    const waiting = await db.tournamentEntry.findMany({
      where: { tenantId: actor.tenantId, tournamentId: id, status: 'PENDING' },
      select: { id: true },
      take: 512,
    });
    if (waiting.length) {
      await db.tournamentEntry.updateMany({
        where: { tenantId: actor.tenantId, id: { in: waiting.map((w) => w.id) } },
        data: { status: 'DECLINED', decidedAt: now, decidedByUserId: actor.userId },
      });
    }
    await db.tournament.updateMany({
      where: { id, tenantId: actor.tenantId },
      data: {
        status: 'IN_PROGRESS',
        drawnAt: now,
        groupCount,
        qualifiersPerGroup: qualifiers,
        thirdPlace,
      },
    });

    await settleByes(db, actor.tenantId, id, now);
    return { declined: waiting.map((w) => w.id) };
  });
}

/** Write a set of matches, linking each to the one its winner (or a semi-final's loser) goes to. */
async function writeMatches(
  db: PrismaClient,
  tenantId: string,
  tournamentId: string,
  specs: readonly MatchSpec[],
  now: Date,
): Promise<void> {
  const ids = new Map(specs.map((s) => [s.key, newId()]));
  await db.tournamentMatch.createMany({
    data: specs.map((s) => ({
      id: ids.get(s.key)!,
      tenantId,
      tournamentId,
      stage: s.stage as TournamentStage,
      round: s.round,
      slot: s.slot,
      groupNo: s.groupNo,
      entryAId: s.entryA,
      entryBId: s.entryB,
      status: (s.entryA && s.entryB ? 'READY' : 'PENDING') as TournamentMatchStatus,
      nextMatchId: s.next ? ids.get(s.next.key)! : null,
      nextSide: s.next?.side ?? null,
      loserNextMatchId: s.loserNext ? ids.get(s.loserNext.key)! : null,
      loserNextSide: s.loserNext?.side ?? null,
      createdAt: now,
    })),
  });
}

/** Round 1 of a knockout: a match with one side is a bye, and that side goes on. */
async function settleByes(
  db: PrismaClient,
  tenantId: string,
  tournamentId: string,
  now: Date,
): Promise<void> {
  const byes = await db.tournamentMatch.findMany({
    where: {
      tenantId,
      tournamentId,
      stage: 'KNOCKOUT',
      round: 1,
      status: 'PENDING',
      OR: [{ entryAId: null }, { entryBId: null }],
    },
    select: { id: true, entryAId: true, entryBId: true },
    take: 512,
  });
  for (const m of byes) {
    if (!m.entryAId && !m.entryBId) continue;
    await decide(db, tenantId, m.id, m.entryAId ? 0 : 1, { status: 'WALKOVER', score: null, now });
  }
}

// ─── Moving on ─────────────────────────────────────────────────────────

/**
 * A match is decided: written, and its winner (and a semi-final's loser) sent
 * on. A group's last match draws the knockout; the last match ends the
 * tournament. Idempotent: a match already decided is left as it is.
 */
async function decide(
  db: PrismaClient,
  tenantId: string,
  matchId: string,
  winnerSide: 0 | 1 | null,
  outcome: {
    status: 'PLAYED' | 'WALKOVER';
    score: number[][] | null;
    now: Date;
    decidedByUserId?: string | null;
  },
): Promise<void> {
  const changed = await db.tournamentMatch.updateMany({
    where: { id: matchId, tenantId, status: { in: ['READY', 'PENDING'] } },
    data: {
      status: outcome.status,
      winnerSide,
      scoreJson: outcome.score ?? undefined,
      playedAt: outcome.now,
      decidedByUserId: outcome.decidedByUserId ?? null,
    },
  });
  if (changed.count !== 1) return;
  const m = await db.tournamentMatch.findFirstOrThrow({
    where: { id: matchId, tenantId },
    select: {
      tournamentId: true,
      stage: true,
      entryAId: true,
      entryBId: true,
      nextMatchId: true,
      nextSide: true,
      loserNextMatchId: true,
      loserNextSide: true,
    },
  });
  if (m.stage === 'GROUP') {
    await afterGroupMatch(db, tenantId, m.tournamentId, outcome.now);
    return;
  }
  const winner = winnerSide === 0 ? m.entryAId : winnerSide === 1 ? m.entryBId : null;
  const loser = winnerSide === 0 ? m.entryBId : winnerSide === 1 ? m.entryAId : null;
  if (m.nextMatchId && winner !== null) {
    await place(db, tenantId, m.nextMatchId, m.nextSide as 0 | 1, winner, outcome.now);
  }
  if (m.loserNextMatchId && loser !== null) {
    await place(db, tenantId, m.loserNextMatchId, m.loserNextSide as 0 | 1, loser, outcome.now);
  }
  await completeIfDone(db, tenantId, m.tournamentId);
}

/** Put an entry on a side of a later match; with both sides there, it is ready, or a walkover. */
async function place(
  db: PrismaClient,
  tenantId: string,
  matchId: string,
  side: 0 | 1,
  entryId: string,
  now: Date,
): Promise<void> {
  const m = await db.tournamentMatch.update({
    where: { id: matchId },
    data: side === 0 ? { entryAId: entryId } : { entryBId: entryId },
    select: { id: true, entryAId: true, entryBId: true, status: true },
  });
  if (!m.entryAId || !m.entryBId || m.status !== 'PENDING') return;
  // A side that withdrew since (59): the other goes on without playing.
  const gone = await db.tournamentEntry.findMany({
    where: { tenantId, id: { in: [m.entryAId, m.entryBId] }, status: 'WITHDRAWN' },
    select: { id: true },
    take: 2,
  });
  if (gone.length > 0) {
    const aGone = gone.some((g) => g.id === m.entryAId);
    const bGone = gone.some((g) => g.id === m.entryBId);
    await decide(db, tenantId, m.id, aGone && !bGone ? 1 : 0, {
      status: 'WALKOVER',
      score: null,
      now,
    });
    return;
  }
  await db.tournamentMatch.updateMany({ where: { id: m.id, tenantId }, data: { status: 'READY' } });
}

/** The knockout's matches are all decided: the tournament is over. */
async function completeIfDone(
  db: PrismaClient,
  tenantId: string,
  tournamentId: string,
): Promise<void> {
  const open = await db.tournamentMatch.count({
    where: { tenantId, tournamentId, status: { in: ['PENDING', 'READY'] } },
  });
  if (open > 0) return;
  await db.tournament.updateMany({
    where: { id: tournamentId, tenantId, status: 'IN_PROGRESS' },
    data: { status: 'COMPLETE' },
  });
}

/** The groups' tables (57), from their decided matches. */
async function groupTables(
  db: PrismaClient,
  tenantId: string,
  tournamentId: string,
): Promise<Map<number, TableRow[]>> {
  const [entries, matches] = await Promise.all([
    db.tournamentEntry.findMany({
      where: {
        tenantId,
        tournamentId,
        groupNo: { not: null },
        status: { in: ['CONFIRMED', 'WITHDRAWN'] },
      },
      select: { id: true, groupNo: true },
      take: 512,
    }),
    db.tournamentMatch.findMany({
      where: { tenantId, tournamentId, stage: 'GROUP', status: { in: ['PLAYED', 'WALKOVER'] } },
      select: {
        groupNo: true,
        entryAId: true,
        entryBId: true,
        winnerSide: true,
        scoreJson: true,
        status: true,
      },
      take: 4096,
    }),
  ]);
  const byGroup = new Map<number, TableRow[]>();
  const groups = [...new Set(entries.map((e) => e.groupNo!))].sort((a, b) => a - b);
  for (const g of groups) {
    const played: PlayedMatch[] = matches
      .filter((m) => m.groupNo === g && m.entryAId && m.entryBId)
      .map((m) => ({
        entryA: m.entryAId!,
        entryB: m.entryBId!,
        winnerSide: m.winnerSide as 0 | 1 | null,
        score: Array.isArray(m.scoreJson) ? (m.scoreJson as number[][]) : null,
        walkover: m.status === 'WALKOVER',
      }));
    byGroup.set(
      g,
      table(
        entries.filter((e) => e.groupNo === g).map((e) => e.id),
        played,
      ),
    );
  }
  return byGroup;
}

/** The last group match decided: a round robin is over; groups draw their knockout (55). */
async function afterGroupMatch(
  db: PrismaClient,
  tenantId: string,
  tournamentId: string,
  now: Date,
): Promise<void> {
  const open = await db.tournamentMatch.count({
    where: { tenantId, tournamentId, stage: 'GROUP', status: { in: ['PENDING', 'READY'] } },
  });
  if (open > 0) return;
  const t = await db.tournament.findFirstOrThrow({
    where: { id: tournamentId, tenantId },
    select: { format: true, qualifiersPerGroup: true, thirdPlace: true },
  });
  if (t.format !== 'GROUPS_KNOCKOUT') {
    await completeIfDone(db, tenantId, tournamentId);
    return;
  }
  const already = await db.tournamentMatch.count({
    where: { tenantId, tournamentId, stage: 'KNOCKOUT' },
  });
  if (already > 0) return;
  const tables = await groupTables(db, tenantId, tournamentId);
  const standings = [...tables.keys()]
    .sort((a, b) => a - b)
    .map((g) => tables.get(g)!.map((r) => r.entryId));
  const seeded = qualifiersInSeedOrder(standings, t.qualifiersPerGroup ?? 2);
  await writeMatches(
    db,
    tenantId,
    tournamentId,
    knockout(seeded, { thirdPlace: t.thirdPlace }),
    now,
  );
  await settleByes(db, tenantId, tournamentId, now);
}

// ─── From a booking's result ───────────────────────────────────────────

/**
 * A booking's result counted (#575): if the booking puts a tournament match on
 * a court, the match is played, with the result's winner and score turned to
 * the match's sides, and the draw moves on. Called inside the counting
 * transaction, with its handle.
 */
export async function matchPlayedFromBooking(
  db: PrismaClient,
  booking: { id: string; tenantId: string },
  result: { sides: string[][]; winnerSide: number | null; score: number[][] | null },
  now: Date = new Date(),
): Promise<void> {
  const m = await db.tournamentMatch.findFirst({
    where: { bookingId: booking.id, tenantId: booking.tenantId },
    select: { id: true, entryAId: true, status: true },
  });
  if (!m || !m.entryAId || (m.status !== 'READY' && m.status !== 'PENDING')) return;
  const a = await db.tournamentEntry.findFirst({
    where: { id: m.entryAId, tenantId: booking.tenantId },
    select: { playerUserId: true },
  });
  // Which side of the result is the match's side A.
  const aIs = result.sides.findIndex((s) => a && s.includes(a.playerUserId));
  const flip = aIs === 1;
  const winnerSide =
    result.winnerSide === null
      ? null
      : ((flip ? 1 - result.winnerSide : result.winnerSide) as 0 | 1);
  const score = result.score ? result.score.map(([x, y]) => (flip ? [y!, x!] : [x!, y!])) : null;
  await decide(db, booking.tenantId, m.id, winnerSide, { status: 'PLAYED', score, now });
}

/**
 * What a booking's result must respect when the booking is a tournament
 * match: the sides the draw set, and a winner in a knockout. Null for a
 * booking that is not one.
 */
export async function tournamentMatchRules(
  db: PrismaClient,
  tenantId: string,
  bookingId: string,
): Promise<{ sides: string[][]; knockout: boolean } | null> {
  const m = await db.tournamentMatch.findFirst({
    where: { bookingId, tenantId },
    select: { stage: true, entryAId: true, entryBId: true },
  });
  if (!m || !m.entryAId || !m.entryBId) return null;
  const entries = await db.tournamentEntry.findMany({
    where: { tenantId, id: { in: [m.entryAId, m.entryBId] } },
    select: { id: true, playerUserId: true, partnerUserId: true },
    take: 2,
  });
  const of = (id: string) => playersOf(entries.find((e) => e.id === id)!);
  return { sides: [of(m.entryAId), of(m.entryBId)], knockout: m.stage !== 'GROUP' };
}

// ─── The club's hand ───────────────────────────────────────────────────

/**
 * The club records a walkover (58, 59): the match goes to `winnerSide`
 * unplayed and unrated, its booking (if any) is cancelled, and the draw moves
 * on.
 */
export async function recordWalkover(
  actor: { userId: string; tenantId: string },
  matchId: string,
  winnerSide: 0 | 1,
  now: Date = new Date(),
): Promise<{ tournamentId: string; bookingId: string | null }> {
  // guardrail-allow: cross-tenant — moving a draw on reads its entries' status;
  // every row is the club's, by its tenantId.
  return runAsSuperuser(async (db) => {
    const m = await db.tournamentMatch.findFirst({
      where: { id: matchId, tenantId: actor.tenantId },
      select: {
        id: true,
        tournamentId: true,
        status: true,
        entryAId: true,
        entryBId: true,
        bookingId: true,
      },
    });
    if (!m) throw notFound();
    await lock(db, actor.tenantId, m.tournamentId);
    if (m.status !== 'READY' || !m.entryAId || !m.entryBId) {
      throw new TournamentDrawError(
        'TOURNAMENT_MATCH_NOT_READY',
        409,
        'This match is not waiting to be played.',
      );
    }
    await decide(db, actor.tenantId, m.id, winnerSide, {
      status: 'WALKOVER',
      score: null,
      now,
      decidedByUserId: actor.userId,
    });
    // Not played: its court is freed.
    if (m.bookingId) {
      const b = await db.booking.findFirst({
        where: { id: m.bookingId, tenantId: actor.tenantId },
        select: { status: true, startTs: true },
      });
      if (b && (b.status === 'CONFIRMED' || b.status === 'PENDING') && b.startTs > now) {
        await cancelBooking(db, actor.tenantId, {
          bookingId: m.bookingId,
          actor: 'STAFF',
          cancelledByUserId: actor.userId,
          reason: 'The tournament match was a walkover.',
          now,
        });
      }
    }
    return { tournamentId: m.tournamentId, bookingId: m.bookingId };
  });
}

/**
 * An entry withdraws while the tournament is under way (59): its played
 * results stand; every match of its that is ready is a walkover to the
 * opponent, and one it would reach later becomes one when the opponent
 * arrives. Called with the entry already WITHDRAWN.
 */
export async function walkoversForWithdrawn(
  db: PrismaClient,
  tenantId: string,
  entryId: string,
  now: Date = new Date(),
): Promise<void> {
  const ready = await db.tournamentMatch.findMany({
    where: { tenantId, status: 'READY', OR: [{ entryAId: entryId }, { entryBId: entryId }] },
    select: { id: true, entryAId: true },
    take: 512,
  });
  for (const m of ready) {
    await decide(db, tenantId, m.id, m.entryAId === entryId ? 1 : 0, {
      status: 'WALKOVER',
      score: null,
      now,
    });
  }
}

export interface ScheduleInput {
  resourceId: string;
  startTs: Date;
  durationMinutes: number;
}

/**
 * The club puts a ready match on a court and time (40): a booking with no
 * booker and the match's players as its participants, free, on the diary like
 * any. A match already on a court moves: its old booking is cancelled.
 * Answers the booking, and the players to tell.
 */
export async function scheduleMatch(
  actor: { userId: string; tenantId: string },
  matchId: string,
  input: ScheduleInput,
  now: Date = new Date(),
): Promise<{ bookingId: string; tournamentId: string; players: string[] }> {
  if (
    !Number.isInteger(input.durationMinutes) ||
    input.durationMinutes < 15 ||
    input.durationMinutes > 480
  ) {
    throw new TournamentDrawError(
      'TOURNAMENT_INVALID',
      400,
      'A match lasts 15 minutes to 8 hours.',
      {
        field: 'durationMinutes',
      },
    );
  }
  // guardrail-allow: cross-tenant — the match's players are each entry's own;
  // every row read and written is the club's, by its tenantId.
  return runAsSuperuser(async (db) => {
    const m = await db.tournamentMatch.findFirst({
      where: { id: matchId, tenantId: actor.tenantId },
      select: {
        id: true,
        tournamentId: true,
        status: true,
        stage: true,
        round: true,
        entryAId: true,
        entryBId: true,
        bookingId: true,
      },
    });
    if (!m) throw notFound();
    const t = await lock(db, actor.tenantId, m.tournamentId);
    if (t.status !== 'IN_PROGRESS' || m.status !== 'READY' || !m.entryAId || !m.entryBId) {
      throw new TournamentDrawError(
        'TOURNAMENT_MATCH_NOT_READY',
        409,
        'Only a ready match goes on a court.',
      );
    }
    const resource = await db.resource.findFirst({
      where: { id: input.resourceId, tenantId: actor.tenantId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!resource) {
      throw new TournamentDrawError(
        'TOURNAMENT_INVALID',
        400,
        'The court is not one of the club’s.',
        {
          field: 'resourceId',
        },
      );
    }
    const entries = await db.tournamentEntry.findMany({
      where: { tenantId: actor.tenantId, id: { in: [m.entryAId, m.entryBId] } },
      select: { id: true, playerUserId: true, partnerUserId: true },
      take: 2,
    });
    const players = [m.entryAId, m.entryBId].flatMap((id) =>
      playersOf(entries.find((e) => e.id === id)!),
    );

    // A match moving: its old booking is cancelled first, so the court is free.
    if (m.bookingId) {
      const old = await db.booking.findFirst({
        where: { id: m.bookingId, tenantId: actor.tenantId },
        select: { status: true },
      });
      if (old && (old.status === 'CONFIRMED' || old.status === 'PENDING')) {
        await cancelBooking(db, actor.tenantId, {
          bookingId: m.bookingId,
          actor: 'STAFF',
          cancelledByUserId: actor.userId,
          reason: 'The tournament match moved to another court or time.',
          now,
        });
      }
    }

    const endTs = new Date(input.startTs.getTime() + input.durationMinutes * 60_000);
    const created = await createBooking(db, actor.tenantId, {
      resourceId: input.resourceId,
      startTs: input.startTs,
      endTs,
      totalCents: 0,
      idempotencyKey: `tmatch:${m.id}:${input.startTs.getTime()}:${input.resourceId}`,
      bookedByUserId: null,
      guestContact: { name: t.name },
      notes: t.name,
      channel: 'DESK',
      onlinePayment: false,
      now,
    });
    if (!created.idempotentReplay) {
      await db.bookingParticipant.createMany({
        data: players.map((userId, i) => ({
          tenantId: actor.tenantId,
          bookingId: created.bookingId,
          userId,
          position: i + 1,
        })),
        skipDuplicates: true,
      });
    }
    await db.tournamentMatch.updateMany({
      where: { id: m.id, tenantId: actor.tenantId },
      data: { bookingId: created.bookingId },
    });
    return { bookingId: created.bookingId, tournamentId: m.tournamentId, players };
  });
}

// ─── Reading the draw ──────────────────────────────────────────────────

export interface DrawEntryView {
  id: string;
  seed: number | null;
  withdrawn: boolean;
  players: Array<{ userId: string; name: string | null; deleted: boolean }>;
}

export interface DrawMatchView {
  id: string;
  stage: TournamentStage;
  round: number;
  slot: number;
  groupNo: number;
  sideA: DrawEntryView | null;
  sideB: DrawEntryView | null;
  status: TournamentMatchStatus;
  winnerSide: number | null;
  score: number[][] | null;
  /** On a court, while its booking stands. */
  scheduled: { bookingId: string; courtName: string; startTs: Date; endTs: Date } | null;
  /** The viewer plays it. */
  mine: boolean;
}

export interface DrawView {
  tournamentId: string;
  format: TournamentFormatKind;
  status: TournamentStatus;
  groups: Array<{
    groupNo: number;
    table: Array<TableRow & { entry: DrawEntryView }>;
    matches: DrawMatchView[];
  }>;
  knockout: DrawMatchView[][];
  thirdPlace: DrawMatchView | null;
}

/**
 * The draw as anybody signed in sees it (decision 49's rule for names): the
 * groups with their tables and matches, the knockout round by round, and the
 * match for third. Null before the draw, for a draft, or a club not public.
 */
export async function readDraw(
  tournamentId: string,
  viewerId: string | null,
  opts: { tenantId?: string } = {},
): Promise<DrawView | null> {
  // guardrail-allow: cross-tenant — one tournament's draw by id, with the
  // names of the people on it; the caller is signed in, or the club's desk.
  return runAsSuperuser(async (db) => {
    const t = await db.tournament.findFirst({
      where: { id: tournamentId, ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) },
      select: { id: true, tenantId: true, format: true, status: true, drawnAt: true },
    });
    if (!t || !t.drawnAt) return null;
    if (!opts.tenantId) {
      const club = await db.venueOrg.findUnique({
        where: { id: t.tenantId },
        select: { status: true },
      });
      if (club?.status !== 'ACTIVE') return null;
    }
    const [entries, matches] = await Promise.all([
      db.tournamentEntry.findMany({
        where: {
          tenantId: t.tenantId,
          tournamentId,
          status: { in: ['CONFIRMED', 'WITHDRAWN'] },
          seed: { not: null },
        },
        select: { id: true, seed: true, status: true, playerUserId: true, partnerUserId: true },
        take: 512,
      }),
      db.tournamentMatch.findMany({
        where: { tenantId: t.tenantId, tournamentId },
        select: {
          id: true,
          stage: true,
          round: true,
          slot: true,
          groupNo: true,
          entryAId: true,
          entryBId: true,
          status: true,
          winnerSide: true,
          scoreJson: true,
          booking: {
            select: {
              id: true,
              status: true,
              startTs: true,
              endTs: true,
              resource: { select: { name: true } },
            },
          },
        },
        orderBy: [{ stage: 'asc' }, { groupNo: 'asc' }, { round: 'asc' }, { slot: 'asc' }],
        take: 4096,
      }),
    ]);
    const userIds = [...new Set(entries.flatMap(playersOf))];
    const users = await db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, deletedAt: true },
      take: userIds.length || 1,
    });
    const userOf = new Map(users.map((u) => [u.id, u]));
    const entryOf = new Map<string, DrawEntryView>(
      entries.map((e) => [
        e.id,
        {
          id: e.id,
          seed: e.seed,
          withdrawn: e.status === 'WITHDRAWN',
          players: playersOf(e).map((id) => {
            const u = userOf.get(id);
            const gone = !u || !!u.deletedAt;
            return { userId: id, name: gone ? null : (u?.name ?? null), deleted: gone };
          }),
        },
      ]),
    );
    const view = (m: (typeof matches)[number]): DrawMatchView => {
      const a = m.entryAId ? (entryOf.get(m.entryAId) ?? null) : null;
      const b = m.entryBId ? (entryOf.get(m.entryBId) ?? null) : null;
      const live = m.booking && m.booking.status !== 'CANCELLED' ? m.booking : null;
      return {
        id: m.id,
        stage: m.stage,
        round: m.round,
        slot: m.slot,
        groupNo: m.groupNo,
        sideA: a,
        sideB: b,
        status: m.status,
        winnerSide: m.winnerSide,
        score: Array.isArray(m.scoreJson) ? (m.scoreJson as number[][]) : null,
        scheduled: live
          ? {
              bookingId: live.id,
              courtName: live.resource.name,
              startTs: live.startTs,
              endTs: live.endTs,
            }
          : null,
        mine: !!viewerId && [a, b].some((s) => s?.players.some((p) => p.userId === viewerId)),
      };
    };

    const tables = await groupTables(db, t.tenantId, tournamentId);
    const groups = [...tables.keys()]
      .sort((x, y) => x - y)
      .map((groupNo) => ({
        groupNo,
        table: tables.get(groupNo)!.map((r) => ({ ...r, entry: entryOf.get(r.entryId)! })),
        matches: matches.filter((m) => m.stage === 'GROUP' && m.groupNo === groupNo).map(view),
      }));
    const ko = matches.filter((m) => m.stage === 'KNOCKOUT');
    const rounds = [...new Set(ko.map((m) => m.round))].sort((x, y) => x - y);
    const third = matches.find((m) => m.stage === 'THIRD_PLACE');
    return {
      tournamentId,
      format: t.format,
      status: t.status,
      groups,
      knockout: rounds.map((r) => ko.filter((m) => m.round === r).map(view)),
      thirdPlace: third ? view(third) : null,
    };
  });
}

export type { Prisma };
