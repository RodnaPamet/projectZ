import {
  Prisma,
  type PrismaClient,
  type SportType,
  type TournamentEntryStatus,
  type TournamentFeePayment,
  type TournamentFormatKind,
  type TournamentStatus,
} from '@prisma/client';

import { blockedEitherWay, isLivePlayer } from '@/app-layer/usecases/messaging-directory';
import { walkoversForWithdrawn } from '@/app-layer/usecases/tournament-draw';
import { requirePlayerAccount } from '@/app-layer/usecases/booking-players';
import { assertPhoneConfirmed } from '@/app-layer/usecases/phone-verification';
import { publicVenueFilter } from '@/app-layer/repositories/public-venue';
import { runAsSuperuser, runInTenantContext } from '@/lib/db/rls-middleware';
import { AppError, RateLimitedError } from '@/lib/errors/types';
import { citySpellings } from '@/lib/geo/cities';
import { checkRateLimit, type RateLimitConfig } from '@/lib/security/rate-limit';
import { isRateLimitBypassed } from '@/lib/security/rate-limit-middleware';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { SPORTS } from '@/lib/sports/registry';

/**
 * A CLUB'S TOURNAMENT: CREATED, OPENED, ENTERED, CONFIRMED (#579; decisions
 * 37–39, 50–53 on #378).
 *
 *   the club (owner, manager or desk: 52)
 *     creates one in DRAFT: sport, format (37), singles or doubles, venue,
 *     dates, draw size, the fee and how it is paid (39), a description
 *     opens it for sign-up                                   → REGISTRATION
 *     confirms entries in sign-up order, up to the draw size (38); the rest
 *     wait, in order: the waiting list (51)
 *     declines one, or cancels the tournament                → CANCELLED
 *   a player
 *     finds it on the club's page or in Игри → «Турнири» (53)
 *     enters it, alone, or naming a partner for doubles (50): the entry goes
 *     straight to the club, and the partner is told and may withdraw
 *     withdraws, as the entrant or the partner, until it starts
 *
 * The draw, the matches on the diary and their results are #580; paying the
 * fee online is #581, and until then a tournament's fee is paid at the club.
 */

export const TOURNAMENT_NAME_MAX = 120;
export const TOURNAMENT_DESCRIPTION_MAX = 2000;
export const DRAW_SIZE_MIN = 2;
export const DRAW_SIZE_MAX = 256;
const ENTER_LIMIT: RateLimitConfig = { maxAttempts: 20, windowMs: 3_600_000 };

/** The formats a club picks from (decision 37); the port's DOUBLE_ELIMINATION and SWISS wait. */
export const CLUB_FORMATS = [
  'SINGLE_ELIMINATION',
  'ROUND_ROBIN',
  'GROUPS_KNOCKOUT',
  'AMERICANO',
  'MEXICANO',
  'LEAGUE',
] as const satisfies readonly TournamentFormatKind[];
export type ClubFormat = (typeof CLUB_FORMATS)[number];

/**
 * Americano and Mexicano: players sign up alone, and the partners rotate from
 * round to round (60). Every match is two against two, but an entry is one.
 */
export const ROTATING_PARTNERS: ReadonlySet<TournamentFormatKind> = new Set([
  'AMERICANO',
  'MEXICANO',
]);

// ─── Errors ──────────────────────────────────────────────────────────────

export type TournamentErrorCode =
  | 'TOURNAMENT_NOT_FOUND'
  | 'TOURNAMENT_NOT_OPEN'
  | 'TOURNAMENT_INVALID'
  | 'TOURNAMENT_ONLINE_FEE_UNAVAILABLE'
  | 'TOURNAMENT_ALREADY_ENTERED'
  | 'TOURNAMENT_PARTNER_REQUIRED'
  | 'TOURNAMENT_PARTNER_UNAVAILABLE'
  | 'TOURNAMENT_DRAW_FULL'
  | 'TOURNAMENT_ENTRY_NOT_FOUND'
  | 'TOURNAMENT_ENTRY_NOT_ACTIVE'
  | 'TOURNAMENT_STATE'
  | 'PLAYER_ACCOUNT_REQUIRED';

/** Every refusal a tournament gives, by code, with its status. */
export class TournamentError extends AppError {
  constructor(
    code: TournamentErrorCode,
    status: 400 | 403 | 404 | 409,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message, code, status, true, details);
    this.name = 'TournamentError';
  }
}

const notFound = () => new TournamentError('TOURNAMENT_NOT_FOUND', 404, 'Tournament not found.');
const invalid = (field: string, message: string) =>
  new TournamentError('TOURNAMENT_INVALID', 400, message, { field });

// ─── Shapes ──────────────────────────────────────────────────────────────

export interface TournamentPerson {
  userId: string;
  name: string | null;
  /** The account was deleted: «Изтрит потребител». */
  deleted: boolean;
}

export interface TournamentSummary {
  id: string;
  name: string;
  sport: SportType;
  format: TournamentFormatKind;
  teamSize: number;
  status: TournamentStatus;
  startsAt: Date;
  endsAt: Date | null;
  entriesCloseAt: Date | null;
  /** Sign-up is open now: REGISTRATION, before it closes and before the start. */
  entriesOpen: boolean;
  drawSize: number;
  confirmed: number;
  /** Waiting for the club, the waiting list included. */
  pending: number;
  entryFeeCents: number;
  feePayment: TournamentFeePayment;
  description: string | null;
  club: { slug: string; name: string };
  venue: { id: string; name: string; city: string; publicSlug: string | null } | null;
}

export interface MyTournamentEntry {
  id: string;
  status: TournamentEntryStatus;
  /** The viewer signed up (entrant), or was named (partner). */
  role: 'entrant' | 'partner';
  /** The other of the pair, in doubles. */
  partner: TournamentPerson | null;
  /** Where a pending entry stands past the draw size: 1 = next in. Null otherwise. */
  waitingPosition: number | null;
  createdAt: Date;
}

export interface TournamentView extends TournamentSummary {
  /** The signed-in viewer's entry, as entrant or partner; null otherwise. */
  myEntry: MyTournamentEntry | null;
}

export interface ClubEntryRow {
  id: string;
  status: TournamentEntryStatus;
  player: TournamentPerson;
  partner: TournamentPerson | null;
  createdAt: Date;
  decidedAt: Date | null;
  withdrawnAt: Date | null;
  /** A pending entry past the draw size's free places: 1 = next in. */
  waitingPosition: number | null;
}

export interface ClubTournamentDetail extends TournamentSummary {
  entries: ClubEntryRow[];
}

// ─── Reading ────────────────────────────────────────────────────────────

const SUMMARY_SELECT = {
  id: true,
  tenantId: true,
  name: true,
  sport: true,
  format: true,
  teamSize: true,
  status: true,
  startsAt: true,
  endsAt: true,
  entriesCloseAt: true,
  maxPlayers: true,
  entryFeeCents: true,
  feePayment: true,
  description: true,
  venue: { select: { id: true, name: true, city: true, publicSlug: true } },
} as const satisfies Prisma.TournamentSelect;

type SummaryRow = Prisma.TournamentGetPayload<{ select: typeof SUMMARY_SELECT }>;

function entriesOpen(
  t: Pick<SummaryRow, 'status' | 'entriesCloseAt' | 'startsAt'>,
  now: Date,
): boolean {
  return (
    t.status === 'REGISTRATION' &&
    t.startsAt > now &&
    (t.entriesCloseAt === null || t.entriesCloseAt > now)
  );
}

async function summarise(
  db: PrismaClient,
  rows: SummaryRow[],
  now: Date,
): Promise<TournamentSummary[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
  const [counts, clubs] = await Promise.all([
    db.tournamentEntry.groupBy({
      by: ['tournamentId', 'status'],
      where: {
        tenantId: { in: tenantIds },
        tournamentId: { in: ids },
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
      _count: { _all: true },
    }),
    db.venueOrg.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true, slug: true, name: true },
      take: tenantIds.length,
    }),
  ]);
  const clubOf = new Map(clubs.map((c) => [c.id, c]));
  const count = (id: string, status: TournamentEntryStatus) =>
    counts.find((c) => c.tournamentId === id && c.status === status)?._count._all ?? 0;
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    sport: t.sport,
    format: t.format,
    teamSize: t.teamSize,
    status: t.status,
    startsAt: t.startsAt,
    endsAt: t.endsAt,
    entriesCloseAt: t.entriesCloseAt,
    entriesOpen: entriesOpen(t, now),
    drawSize: t.maxPlayers,
    confirmed: count(t.id, 'CONFIRMED'),
    pending: count(t.id, 'PENDING'),
    entryFeeCents: t.entryFeeCents,
    feePayment: t.feePayment,
    description: t.description,
    club: { slug: clubOf.get(t.tenantId)?.slug ?? '', name: clubOf.get(t.tenantId)?.name ?? '' },
    venue: t.venue,
  }));
}

async function peopleOf(
  db: PrismaClient,
  ids: readonly string[],
): Promise<(id: string) => TournamentPerson> {
  const unique = [...new Set(ids)];
  const rows = unique.length
    ? await db.user.findMany({
        where: { id: { in: unique } },
        select: { id: true, name: true, deletedAt: true },
        take: unique.length,
      })
    : [];
  const byId = new Map(rows.map((u) => [u.id, u]));
  return (id) => {
    const u = byId.get(id);
    const gone = !u || !!u.deletedAt;
    return { userId: id, name: gone ? null : (u?.name ?? null), deleted: gone };
  };
}

/** Pending entries past the free places, by sign-up order: their place in the queue. */
function waitingPositions(
  drawSize: number,
  entries: ReadonlyArray<{ id: string; status: TournamentEntryStatus; createdAt: Date }>,
): Map<string, number> {
  const free = Math.max(0, drawSize - entries.filter((e) => e.status === 'CONFIRMED').length);
  const pending = entries
    .filter((e) => e.status === 'PENDING')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  const out = new Map<string, number>();
  pending.forEach((e, i) => {
    if (i >= free) out.set(e.id, i - free + 1);
  });
  return out;
}

export interface OpenTournamentsFilter {
  city?: string | null;
  sport?: SportType | null;
}

/**
 * Tournaments open for sign-up, across clubs (decision 53): in REGISTRATION,
 * starting later, at a public venue, soonest first. Anyone may read it.
 */
export async function listOpenTournaments(
  filter: OpenTournamentsFilter = {},
  opts: { now?: Date; limit?: number } = {},
): Promise<TournamentSummary[]> {
  const now = opts.now ?? new Date();
  const limit = Math.min(opts.limit ?? 50, 100);
  // guardrail-allow: cross-tenant — the public list of tournaments open for
  // sign-up at every club, as open play's list of games is.
  return runAsSuperuser(async (db) => {
    const venues = await publicVenueFilter(db);
    const cities = filter.city ? citySpellings(filter.city) : null;
    const rows = await db.tournament.findMany({
      where: {
        status: 'REGISTRATION',
        startsAt: { gt: now },
        OR: [{ entriesCloseAt: null }, { entriesCloseAt: { gt: now } }],
        ...(filter.sport ? { sport: filter.sport } : {}),
        venue: {
          AND: [
            venues.where,
            ...(cities ? [{ city: { in: cities, mode: 'insensitive' as const } }] : []),
          ],
        },
      },
      select: SUMMARY_SELECT,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return summarise(db, rows, now);
  });
}

/** A club's tournaments for its public page: open for sign-up or under way. */
export async function listClubPublicTournaments(
  slug: string,
  now: Date = new Date(),
): Promise<TournamentSummary[]> {
  // guardrail-allow: cross-tenant — one public club by its slug, and its
  // tournaments open or under way.
  return runAsSuperuser(async (db) => {
    const club = await db.venueOrg.findUnique({
      where: { slug },
      select: { id: true, status: true },
    });
    if (!club || club.status !== 'ACTIVE') return [];
    const rows = await db.tournament.findMany({
      where: {
        tenantId: club.id,
        status: { in: ['REGISTRATION', 'IN_PROGRESS'] },
        OR: [
          { endsAt: null, startsAt: { gt: new Date(now.getTime() - 86_400_000) } },
          { endsAt: { gt: now } },
        ],
      },
      select: SUMMARY_SELECT,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: 20,
    });
    return summarise(db, rows, now);
  });
}

/**
 * One tournament as a player sees it: the public facts, and their own entry.
 * Null for one that does not exist, is still a draft, or is at a club that is
 * not public.
 */
export async function getTournament(
  id: string,
  viewerId: string | null,
  now: Date = new Date(),
): Promise<TournamentView | null> {
  // guardrail-allow: cross-tenant — one tournament by id, at whichever club.
  return runAsSuperuser(async (db) => {
    const t = await db.tournament.findUnique({ where: { id }, select: SUMMARY_SELECT });
    if (!t || t.status === 'DRAFT') return null;
    const club = await db.venueOrg.findUnique({
      where: { id: t.tenantId },
      select: { status: true },
    });
    if (club?.status !== 'ACTIVE') return null;
    const [summary] = await summarise(db, [t], now);
    let myEntry: MyTournamentEntry | null = null;
    if (viewerId) {
      const mine = await db.tournamentEntry.findFirst({
        where: {
          tenantId: t.tenantId,
          tournamentId: id,
          OR: [{ playerUserId: viewerId }, { partnerUserId: viewerId }],
          status: { in: ['PENDING', 'CONFIRMED', 'DECLINED'] },
        },
        select: {
          id: true,
          status: true,
          playerUserId: true,
          partnerUserId: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (mine) {
        const entries = await db.tournamentEntry.findMany({
          where: {
            tenantId: t.tenantId,
            tournamentId: id,
            status: { in: ['PENDING', 'CONFIRMED'] },
          },
          select: { id: true, status: true, createdAt: true },
          take: DRAW_SIZE_MAX * 4,
        });
        const role = mine.playerUserId === viewerId ? 'entrant' : 'partner';
        const otherId = role === 'entrant' ? mine.partnerUserId : mine.playerUserId;
        const person = await peopleOf(db, otherId ? [otherId] : []);
        myEntry = {
          id: mine.id,
          status: mine.status,
          role,
          partner: otherId ? person(otherId) : null,
          waitingPosition: waitingPositions(t.maxPlayers, entries).get(mine.id) ?? null,
          createdAt: mine.createdAt,
        };
      }
    }
    return { ...summary!, myEntry };
  });
}

// ─── The club's side ────────────────────────────────────────────────────

export interface TournamentInput {
  name: string;
  sport: SportType;
  format: ClubFormat;
  teamSize: 1 | 2;
  venueId: string;
  startsAt: Date;
  endsAt?: Date | null;
  entriesCloseAt?: Date | null;
  drawSize: number;
  entryFeeCents: number;
  feePayment: TournamentFeePayment;
  description?: string | null;
}

function clean(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const v = sanitizePlainText(text).trim();
  return v ? v.slice(0, max) : null;
}

function check(input: TournamentInput, now: Date): void {
  if (!clean(input.name, TOURNAMENT_NAME_MAX)) throw invalid('name', 'A tournament has a name.');
  if (!SPORTS[input.sport]) throw invalid('sport', 'Unknown sport.');
  if (ROTATING_PARTNERS.has(input.format) && input.teamSize !== 1) {
    throw invalid(
      'teamSize',
      'In Americano and Mexicano players sign up alone; the partners rotate.',
    );
  }
  if (input.startsAt <= now) throw invalid('startsAt', 'A tournament starts later than now.');
  if (input.endsAt && input.endsAt < input.startsAt)
    throw invalid('endsAt', 'It ends after it starts.');
  if (input.entriesCloseAt && input.entriesCloseAt > input.startsAt) {
    throw invalid('entriesCloseAt', 'Sign-up closes by the start.');
  }
  if (
    !Number.isInteger(input.drawSize) ||
    input.drawSize < DRAW_SIZE_MIN ||
    input.drawSize > DRAW_SIZE_MAX
  ) {
    throw invalid('drawSize', `The draw is ${DRAW_SIZE_MIN} to ${DRAW_SIZE_MAX} entries.`);
  }
  if (!Number.isInteger(input.entryFeeCents) || input.entryFeeCents < 0) {
    throw invalid('entryFeeCents', 'The fee is a whole number of cents, 0 or more.');
  }
  if (input.feePayment === 'ONLINE') {
    // #581: Stripe Connect, the owner's keys and each club's onboarding.
    throw new TournamentError(
      'TOURNAMENT_ONLINE_FEE_UNAVAILABLE',
      409,
      'Paying the entry fee online is not available yet: it is paid at the club.',
    );
  }
}

async function venueOfClub(db: PrismaClient, tenantId: string, venueId: string): Promise<void> {
  const v = await db.venue.findFirst({
    where: { id: venueId, tenantId, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!v) throw invalid('venueId', 'The venue is not one of the club’s.');
}

/** The club creates a tournament, in DRAFT. */
export async function createTournament(
  actor: { userId: string; tenantId: string },
  input: TournamentInput,
  now: Date = new Date(),
): Promise<{ id: string }> {
  check(input, now);
  return runInTenantContext(actor.tenantId, async (db) => {
    await venueOfClub(db, actor.tenantId, input.venueId);
    return db.tournament.create({
      data: {
        tenantId: actor.tenantId,
        name: clean(input.name, TOURNAMENT_NAME_MAX)!,
        sport: input.sport,
        format: input.format,
        teamSize: input.teamSize,
        venueId: input.venueId,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        entriesCloseAt: input.entriesCloseAt ?? null,
        maxPlayers: input.drawSize,
        entryFeeCents: input.entryFeeCents,
        feePayment: input.feePayment,
        description: clean(input.description, TOURNAMENT_DESCRIPTION_MAX),
        createdByUserId: actor.userId,
      },
      select: { id: true },
    });
  });
}

/**
 * The club changes a tournament before it starts. Once anybody has entered,
 * the format and singles-or-doubles stay as they were signed up for, and the
 * draw cannot shrink below the entries already confirmed.
 */
export async function updateTournament(
  actor: { userId: string; tenantId: string },
  id: string,
  input: TournamentInput,
  now: Date = new Date(),
): Promise<void> {
  check(input, now);
  await runInTenantContext(actor.tenantId, async (db) => {
    const t = await lockTournament(db, actor.tenantId, id);
    if (t.status !== 'DRAFT' && t.status !== 'REGISTRATION') {
      throw new TournamentError(
        'TOURNAMENT_STATE',
        409,
        'Only a tournament not yet started changes.',
      );
    }
    const entries = await db.tournamentEntry.groupBy({
      by: ['status'],
      where: {
        tenantId: actor.tenantId,
        tournamentId: id,
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
      _count: { _all: true },
    });
    const active = entries.reduce((n, e) => n + e._count._all, 0);
    const confirmed = entries.find((e) => e.status === 'CONFIRMED')?._count._all ?? 0;
    if (active > 0 && (input.format !== t.format || input.teamSize !== t.teamSize)) {
      throw invalid('format', 'Entries were made for this format and team size.');
    }
    if (input.drawSize < confirmed) {
      throw invalid('drawSize', 'The draw cannot be smaller than the entries confirmed.');
    }
    await venueOfClub(db, actor.tenantId, input.venueId);
    await db.tournament.update({
      where: { id },
      data: {
        name: clean(input.name, TOURNAMENT_NAME_MAX)!,
        sport: input.sport,
        format: input.format,
        teamSize: input.teamSize,
        venueId: input.venueId,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        entriesCloseAt: input.entriesCloseAt ?? null,
        maxPlayers: input.drawSize,
        entryFeeCents: input.entryFeeCents,
        feePayment: input.feePayment,
        description: clean(input.description, TOURNAMENT_DESCRIPTION_MAX),
      },
    });
  });
}

async function lockTournament(
  db: PrismaClient,
  tenantId: string,
  id: string,
): Promise<{
  id: string;
  status: TournamentStatus;
  format: TournamentFormatKind;
  teamSize: number;
  maxPlayers: number;
  startsAt: Date;
  entriesCloseAt: Date | null;
}> {
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      status: TournamentStatus;
      format: TournamentFormatKind;
      teamSize: number;
      maxPlayers: number;
      startsAt: Date;
      entriesCloseAt: Date | null;
    }>
  >`SELECT "id", "status", "format", "teamSize", "maxPlayers", "startsAt", "entriesCloseAt"
      FROM "tournament" WHERE "id" = ${id} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const t = rows[0];
  if (!t) throw notFound();
  return t;
}

/** DRAFT → REGISTRATION: sign-up opens. */
export async function openTournament(
  actor: { userId: string; tenantId: string },
  id: string,
  now: Date = new Date(),
): Promise<void> {
  await runInTenantContext(actor.tenantId, async (db) => {
    const t = await lockTournament(db, actor.tenantId, id);
    if (t.status !== 'DRAFT')
      throw new TournamentError('TOURNAMENT_STATE', 409, 'Only a draft opens.');
    if (t.startsAt <= now) throw invalid('startsAt', 'A tournament starts later than now.');
    await db.tournament.update({ where: { id }, data: { status: 'REGISTRATION' } });
  });
}

/**
 * The club cancels a tournament not yet finished. Answers the entries that
 * were live, for the caller to tell their players.
 */
export async function cancelTournament(
  actor: { userId: string; tenantId: string },
  id: string,
): Promise<{ entryIds: string[] }> {
  return runInTenantContext(actor.tenantId, async (db) => {
    const t = await lockTournament(db, actor.tenantId, id);
    if (t.status === 'CANCELLED' || t.status === 'COMPLETE') {
      throw new TournamentError('TOURNAMENT_STATE', 409, 'This tournament is over.');
    }
    const live = await db.tournamentEntry.findMany({
      where: {
        tenantId: actor.tenantId,
        tournamentId: id,
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
      select: { id: true },
      take: DRAW_SIZE_MAX * 4,
    });
    await db.tournament.update({ where: { id }, data: { status: 'CANCELLED' } });
    return { entryIds: live.map((e) => e.id) };
  });
}

/** The club's tournaments, the latest first, for its admin. */
export async function listClubTournaments(
  tenantId: string,
  now: Date = new Date(),
): Promise<TournamentSummary[]> {
  return runInTenantContext(tenantId, async (db) => {
    const rows = await db.tournament.findMany({
      where: { tenantId },
      select: SUMMARY_SELECT,
      orderBy: [{ startsAt: 'desc' }, { id: 'asc' }],
      take: 100,
    });
    // The club's own name and slug: summarise reads them by tenant.
    return summarise(db, rows, now);
  });
}

/** One of the club's tournaments, with every entry, for its admin. */
export async function getClubTournament(
  tenantId: string,
  id: string,
  now: Date = new Date(),
): Promise<ClubTournamentDetail | null> {
  const found = await runInTenantContext(tenantId, async (db) => {
    const t = await db.tournament.findFirst({ where: { id, tenantId }, select: SUMMARY_SELECT });
    if (!t) return null;
    const [summary] = await summarise(db, [t], now);
    const entries = await db.tournamentEntry.findMany({
      where: { tenantId, tournamentId: id },
      select: {
        id: true,
        status: true,
        playerUserId: true,
        partnerUserId: true,
        createdAt: true,
        decidedAt: true,
        withdrawnAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: DRAW_SIZE_MAX * 4,
    });
    return { summary: summary!, drawSize: t.maxPlayers, entries };
  });
  if (!found) return null;
  // guardrail-allow: cross-tenant — the names of the people who entered the
  // club's own tournament, which the club confirms them by.
  const person = await runAsSuperuser((db) =>
    peopleOf(
      db,
      found.entries.flatMap((e) =>
        e.partnerUserId ? [e.playerUserId, e.partnerUserId] : [e.playerUserId],
      ),
    ),
  );
  const waiting = waitingPositions(found.drawSize, found.entries);
  return {
    ...found.summary,
    entries: found.entries.map((e) => ({
      id: e.id,
      status: e.status,
      player: person(e.playerUserId),
      partner: e.partnerUserId ? person(e.partnerUserId) : null,
      createdAt: e.createdAt,
      decidedAt: e.decidedAt,
      withdrawnAt: e.withdrawnAt,
      waitingPosition: waiting.get(e.id) ?? null,
    })),
  };
}

/**
 * The club confirms an entry, while there is a place in the draw (38), or
 * declines one, pending or confirmed. Answers the tournament, for the notice.
 */
export async function decideEntry(
  actor: { userId: string; tenantId: string },
  entryId: string,
  action: 'confirm' | 'decline',
  now: Date = new Date(),
): Promise<{ tournamentId: string; status: TournamentEntryStatus }> {
  return runInTenantContext(actor.tenantId, async (db) => {
    const entry = await db.tournamentEntry.findFirst({
      where: { id: entryId, tenantId: actor.tenantId },
      select: { id: true, tournamentId: true, status: true },
    });
    if (!entry) throw new TournamentError('TOURNAMENT_ENTRY_NOT_FOUND', 404, 'Entry not found.');
    const t = await lockTournament(db, actor.tenantId, entry.tournamentId);
    if (t.status !== 'REGISTRATION') {
      throw new TournamentError(
        'TOURNAMENT_STATE',
        409,
        'Entries are decided while sign-up is open.',
      );
    }
    const allowed: TournamentEntryStatus[] =
      action === 'confirm' ? ['PENDING'] : ['PENDING', 'CONFIRMED'];
    if (!allowed.includes(entry.status)) {
      throw new TournamentError(
        'TOURNAMENT_ENTRY_NOT_ACTIVE',
        409,
        'This entry is not waiting for that.',
      );
    }
    if (action === 'confirm') {
      const confirmed = await db.tournamentEntry.count({
        where: { tenantId: actor.tenantId, tournamentId: t.id, status: 'CONFIRMED' },
      });
      if (confirmed >= t.maxPlayers) {
        throw new TournamentError('TOURNAMENT_DRAW_FULL', 409, 'The draw is full.', {
          drawSize: t.maxPlayers,
        });
      }
    }
    const status: TournamentEntryStatus = action === 'confirm' ? 'CONFIRMED' : 'DECLINED';
    await db.tournamentEntry.update({
      where: { id: entryId },
      data: { status, decidedAt: now, decidedByUserId: actor.userId },
    });
    return { tournamentId: t.id, status };
  });
}

// ─── The player's side ──────────────────────────────────────────────────

/**
 * A player enters a tournament open for sign-up: alone, or naming a partner
 * for doubles (decision 50). The entry waits for the club (38). Answers it,
 * for the notices.
 */
export async function enterTournament(
  input: { userId: string; tournamentId: string; partnerUserId?: string | null },
  now: Date = new Date(),
): Promise<{ entryId: string; tenantId: string }> {
  if (!(await isLivePlayer(input.userId))) {
    await runAsSuperuser((db) => requirePlayerAccount(db, input.userId));
    throw new TournamentError('PLAYER_ACCOUNT_REQUIRED', 403, 'Entering needs a player account.');
  }
  await assertPhoneConfirmed(input.userId);

  // guardrail-allow: cross-tenant — which club a tournament id is at, before
  // any club is bound; the id came from a public page.
  const found = await runAsSuperuser((db) =>
    db.tournament.findUnique({
      where: { id: input.tournamentId },
      select: { tenantId: true, status: true, teamSize: true },
    }),
  );
  if (!found || found.status === 'DRAFT') throw notFound();

  const partnerId = input.partnerUserId ?? null;
  if (found.teamSize === 2 && !partnerId) {
    throw new TournamentError(
      'TOURNAMENT_PARTNER_REQUIRED',
      400,
      'A doubles entry names a partner.',
    );
  }
  if (found.teamSize === 1 && partnerId)
    throw invalid('partnerUserId', 'A singles entry is one player.');
  if (partnerId) {
    // A live player, not oneself, and in no block with the entrant.
    const ok =
      partnerId !== input.userId &&
      (await isLivePlayer(partnerId)) &&
      // guardrail-allow: cross-tenant — the entrant's own blocks, by their id.
      !(await runAsSuperuser((db) => blockedEitherWay(db, input.userId))).includes(partnerId);
    if (!ok) {
      throw new TournamentError(
        'TOURNAMENT_PARTNER_UNAVAILABLE',
        409,
        'That player cannot be named as a partner.',
      );
    }
  }

  if (!isRateLimitBypassed()) {
    const r = await checkRateLimit(`tournament-enter:u:${input.userId}`, ENTER_LIMIT);
    if (!r.allowed) throw new RateLimitedError('Too many entries. Try again later.');
  }

  const entryId = await runInTenantContext(found.tenantId, async (db) => {
    const t = await lockTournament(db, found.tenantId, input.tournamentId);
    if (
      !entriesOpen(
        { status: t.status, entriesCloseAt: t.entriesCloseAt, startsAt: t.startsAt },
        now,
      )
    ) {
      throw new TournamentError(
        'TOURNAMENT_NOT_OPEN',
        409,
        'Sign-up for this tournament is closed.',
      );
    }
    const people = partnerId ? [input.userId, partnerId] : [input.userId];
    // Each person is in one live entry of a tournament, as entrant or partner.
    const clash = await db.tournamentEntry.findFirst({
      where: {
        tenantId: found.tenantId,
        tournamentId: t.id,
        status: { in: ['PENDING', 'CONFIRMED'] },
        OR: [{ playerUserId: { in: people } }, { partnerUserId: { in: people } }],
      },
      select: { playerUserId: true, partnerUserId: true },
    });
    if (clash) {
      const mine = clash.playerUserId === input.userId || clash.partnerUserId === input.userId;
      throw mine
        ? new TournamentError(
            'TOURNAMENT_ALREADY_ENTERED',
            409,
            'You are already in this tournament.',
          )
        : new TournamentError(
            'TOURNAMENT_PARTNER_UNAVAILABLE',
            409,
            'Your partner is already in this tournament.',
          );
    }
    // A withdrawn or declined entry of the entrant's comes back as a new one,
    // at the back of the queue; a past one as someone's partner is left as it is.
    const prior = await db.tournamentEntry.findUnique({
      where: { tournamentId_playerUserId: { tournamentId: t.id, playerUserId: input.userId } },
      select: { id: true },
    });
    // The partner column is unique too: free it from an entry no longer live.
    if (partnerId) {
      await db.tournamentEntry.updateMany({
        where: {
          tenantId: found.tenantId,
          tournamentId: t.id,
          partnerUserId: partnerId,
          status: { in: ['DECLINED', 'WITHDRAWN'] },
        },
        data: { partnerUserId: null },
      });
    }
    const data = {
      partnerUserId: partnerId,
      status: 'PENDING' as const,
      createdAt: now,
      decidedAt: null,
      decidedByUserId: null,
      withdrawnAt: null,
      withdrawnByUserId: null,
    };
    const row = prior
      ? await db.tournamentEntry.update({ where: { id: prior.id }, data, select: { id: true } })
      : await db.tournamentEntry.create({
          data: {
            ...data,
            tenantId: found.tenantId,
            tournamentId: t.id,
            playerUserId: input.userId,
          },
          select: { id: true },
        });
    return row.id;
  });
  return { entryId, tenantId: found.tenantId };
}

/**
 * The entrant or the partner withdraws a live entry before the tournament
 * starts (decision 50: the partner may). Answers who is left to tell.
 */
export async function withdrawEntry(
  userId: string,
  entryId: string,
  now: Date = new Date(),
): Promise<{ tenantId: string; tournamentId: string; wasConfirmed: boolean }> {
  // guardrail-allow: cross-tenant — one entry by id, to find its club; it is
  // matched to the caller before anything else is read.
  const found = await runAsSuperuser((db) =>
    db.tournamentEntry.findUnique({
      where: { id: entryId },
      select: { tenantId: true, tournamentId: true, playerUserId: true, partnerUserId: true },
    }),
  );
  if (!found || (found.playerUserId !== userId && found.partnerUserId !== userId)) {
    throw new TournamentError('TOURNAMENT_ENTRY_NOT_FOUND', 404, 'Entry not found.');
  }
  return runInTenantContext(found.tenantId, async (db) => {
    const t = await lockTournament(db, found.tenantId, found.tournamentId);
    if (t.status !== 'REGISTRATION' && t.status !== 'DRAFT' && t.status !== 'IN_PROGRESS') {
      throw new TournamentError('TOURNAMENT_STATE', 409, 'The tournament is over.');
    }
    const entry = await db.tournamentEntry.findFirstOrThrow({
      where: { id: entryId, tenantId: found.tenantId },
      select: { status: true },
    });
    if (entry.status !== 'PENDING' && entry.status !== 'CONFIRMED') {
      throw new TournamentError('TOURNAMENT_ENTRY_NOT_ACTIVE', 409, 'This entry is not live.');
    }
    await db.tournamentEntry.update({
      where: { id: entryId },
      data: { status: 'WITHDRAWN', withdrawnAt: now, withdrawnByUserId: userId },
    });
    // Under way (59): played results stand; its other matches are walkovers.
    if (t.status === 'IN_PROGRESS') await walkoversForWithdrawn(db, found.tenantId, entryId, now);
    return {
      tenantId: found.tenantId,
      tournamentId: found.tournamentId,
      wasConfirmed: entry.status === 'CONFIRMED',
    };
  });
}

/** The tournaments a person is entered in, live, at every club: their own list. */
export async function myTournamentEntries(
  userId: string,
  now: Date = new Date(),
): Promise<TournamentView[]> {
  // guardrail-allow: cross-tenant — the person's own entries, at every club.
  const ids = await runAsSuperuser((db) =>
    db.tournamentEntry.findMany({
      where: {
        OR: [{ playerUserId: userId }, { partnerUserId: userId }],
        status: { in: ['PENDING', 'CONFIRMED'] },
        tournament: { status: { in: ['REGISTRATION', 'IN_PROGRESS'] } },
      },
      select: { tournamentId: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  );
  const views = await Promise.all(ids.map((e) => getTournament(e.tournamentId, userId, now)));
  return views.filter((v): v is TournamentView => v !== null);
}

/** The club's venues and the sports their courts are for: where a tournament can be played. */
export async function clubVenuesForTournaments(tenantId: string): Promise<
  Array<{
    id: string;
    name: string;
    sports: SportType[];
    courts: Array<{ id: string; name: string }>;
  }>
> {
  return runInTenantContext(tenantId, async (db) => {
    const venues = await db.venue.findMany({
      where: { tenantId, status: 'ACTIVE' },
      select: {
        id: true,
        name: true,
        resources: {
          where: { status: 'ACTIVE' },
          select: { id: true, name: true, sport: true },
          orderBy: { name: 'asc' },
          take: 200,
        },
      },
      orderBy: { name: 'asc' },
      take: 50,
    });
    return venues.map((v) => ({
      id: v.id,
      name: v.name,
      sports: [...new Set(v.resources.map((r) => r.sport))],
      courts: v.resources.map((r) => ({ id: r.id, name: r.name })),
    }));
  });
}

/**
 * The club withdraws an entry from a tournament under way (59): its played
 * results stand, its other matches are walkovers. Before the draw, the club
 * declines an entry instead.
 */
export async function withdrawEntryAsClub(
  actor: { userId: string; tenantId: string },
  entryId: string,
  now: Date = new Date(),
): Promise<{ tournamentId: string }> {
  return runInTenantContext(actor.tenantId, async (db) => {
    const entry = await db.tournamentEntry.findFirst({
      where: { id: entryId, tenantId: actor.tenantId },
      select: { tournamentId: true, status: true },
    });
    if (!entry) throw new TournamentError('TOURNAMENT_ENTRY_NOT_FOUND', 404, 'Entry not found.');
    const t = await lockTournament(db, actor.tenantId, entry.tournamentId);
    if (t.status !== 'IN_PROGRESS' || entry.status !== 'CONFIRMED') {
      throw new TournamentError(
        'TOURNAMENT_ENTRY_NOT_ACTIVE',
        409,
        'Only a confirmed entry is withdrawn from a tournament under way.',
      );
    }
    await db.tournamentEntry.update({
      where: { id: entryId },
      data: { status: 'WITHDRAWN', withdrawnAt: now, withdrawnByUserId: actor.userId },
    });
    await walkoversForWithdrawn(db, actor.tenantId, entryId, now);
    return { tournamentId: entry.tournamentId };
  });
}
