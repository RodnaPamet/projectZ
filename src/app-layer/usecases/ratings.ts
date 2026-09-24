import { Prisma, type PrismaClient, type SportType } from '@prisma/client';

import { awardXp } from '@/app-layer/usecases/gamification';
import {
  type SportRating,
  displayFor,
  engineFor,
  newRatingFor,
  rateMatch,
} from '@/lib/ratings/engine';

/**
 * Recording results and moving ratings.
 *
 * ─── Why this MUST be idempotent ─────────────────────────────────────
 *
 * A rating update is NOT reversible by subtraction. Applying the same match
 * twice does not just double a delta — it feeds the second update a mu and
 * sigma that already contain the first, and the result is a rating that no
 * sequence of real matches could have produced. There is no clean way back:
 * you would have to replay the player's entire history from scratch.
 *
 * So `dedupeKey` is a UNIQUE column, and a re-reported result is a no-op rather
 * than a second rating. Same discipline as XP (P18) — and here the stakes are
 * higher, because XP can be clawed back and a corrupted rating cannot.
 */

export class UnknownPlayerRatingError extends Error {
  readonly code = 'unknown_player_rating';
  constructor(userId: string, sport: SportType) {
    super(`No rating state for ${userId} in ${sport}, and none could be created.`);
    this.name = 'UnknownPlayerRatingError';
  }
}

/**
 * The player's CURRENT rating for a sport — their latest history row, or a
 * fresh one.
 *
 * A player with no history gets a NEW rating rather than an error. Everyone is
 * unrated before their first match, and that is not an exceptional condition.
 */
export async function currentRating(
  db: PrismaClient,
  userId: string,
  sport: SportType,
): Promise<SportRating> {
  const latest = await db.skillRatingHistory.findFirst({
    where: { userId, sport },
    orderBy: { computedAt: 'desc' },
  });

  if (!latest) return newRatingFor(sport);

  // Trust the row's OWN engine, not the registry's current answer. If a sport's
  // engine were ever changed, old rows still have to be read in the system that
  // wrote them — otherwise a chess history renders as a cliff where the rating
  // apparently fell from 1500 to 25 overnight.
  if (latest.engine === 'GLICKO2') {
    return {
      engine: 'GLICKO2',
      state: {
        mu: Number(latest.mu),
        // The CHECK constraint guarantees phi is present on a Glicko row. The
        // fallback is defensive only, and would be a bug if it ever fired.
        phi: Number(latest.phi ?? 350),
        sigma: Number(latest.sigma),
        matchesPlayed: latest.matchesPlayed,
      },
    };
  }

  return {
    engine: 'OPENSKILL',
    state: { mu: Number(latest.mu), sigma: Number(latest.sigma) },
  };
}

export interface RecordMatchInput {
  tenantId?: string | null;
  sport: SportType;
  /** Teams, ordered BEST-FIRST. teams[0] beat teams[1]. */
  teams: string[][];
  /** Lower is better; equal values are a draw. Defaults to the array order. */
  ranks?: number[];
  sessionId?: string;
  reportedByUserId?: string;
  /** What makes this result unique: `session:sess_123`, `tournament:t1:r3:m2`. */
  dedupeKey: string;
}

/**
 * Record a result and re-rate everyone in it.
 */
export async function recordMatch(
  db: PrismaClient,
  input: RecordMatchInput,
): Promise<{ recorded: boolean; ratings: Map<string, { before: number; after: number }> }> {
  const players = input.teams.flat();

  if (new Set(players).size !== players.length) {
    // The same person on both sides of a match is not a match. Rating it would
    // update one player against themselves, and both updates would land on the
    // same row — the later write silently winning.
    throw new Error('A player cannot appear twice in one match.');
  }

  // ── The idempotency gate ──────────────────────────────────────────
  //
  // Claim the dedupe key FIRST, before touching a single rating. If the claim
  // fails, this result has already been rated and we stop — no rating is
  // recomputed, nothing moves.
  //
  // createMany({skipDuplicates}) rather than create()+catch: a unique violation
  // ABORTS the transaction, so recovery in the catch cannot run. (P09, P10, P18,
  // and now here.)
  const claim = await db.matchResultRecord.createMany({
    data: [
      {
        tenantId: input.tenantId ?? null,
        sport: input.sport,
        sessionId: input.sessionId ?? null,
        teamsJson: input.teams,
        ranksJson: input.ranks ?? input.teams.map((_, i) => i + 1),
        dedupeKey: input.dedupeKey,
        reportedByUserId: input.reportedByUserId ?? null,
      },
    ],
    skipDuplicates: true,
  });

  if (claim.count === 0) {
    // Already rated. Not an error — a redelivered webhook, a double-tapped
    // "report result" button.
    return { recorded: false, ratings: new Map() };
  }

  const before = new Map<string, SportRating>();
  const playedBefore = new Map<string, number>();

  for (const userId of players) {
    before.set(userId, await currentRating(db, userId, input.sport));
    playedBefore.set(userId, await matchesPlayedFor(db, userId, input.sport));
  }

  const after = rateMatch({
    sport: input.sport,
    teams: input.teams.map((team) =>
      team.map((userId) => ({ userId, rating: before.get(userId)! })),
    ),
    ranks: input.ranks,
  });

  const engine = engineFor(input.sport);
  const deltas = new Map<string, { before: number; after: number }>();

  const ranks = input.ranks ?? input.teams.map((_, i) => i + 1);
  const bestRank = Math.min(...ranks);

  await db.$transaction(async (tx) => {
    // The participant rows. These are what the dashboard actually queries — see
    // MatchParticipant in the schema for why scanning teamsJson is not merely
    // slow but WRONG.
    const match = await tx.matchResultRecord.findUniqueOrThrow({
      where: { dedupeKey: input.dedupeKey },
      select: { id: true },
    });

    await tx.matchParticipant.createMany({
      data: input.teams.flatMap((team, teamIndex) =>
        team.map((userId) => ({
          matchId: match.id,
          userId,
          sport: input.sport,
          teamIndex,
          rank: ranks[teamIndex]!,
          // Computed ONCE, here, from the ranks. A DRAW is "somebody else shares
          // my rank", not "I came first" — conflating them inflates the win rate
          // of every player in a sport where draws are common.
          outcome: (ranks.filter((r) => r === ranks[teamIndex]!).length > 1
            ? 'DRAW'
            : ranks[teamIndex] === bestRank
              ? 'WIN'
              : 'LOSS') as 'WIN' | 'LOSS' | 'DRAW',
        })),
      ),
      skipDuplicates: true,
    });

    for (const [userId, rating] of after) {
      const previous = before.get(userId)!;

      await tx.skillRatingHistory.create({
        data: {
          userId,
          sport: input.sport,
          engine,
          mu: new Prisma.Decimal(rating.state.mu),
          // NULL for openskill. A 0 would read as "perfectly certain", which is
          // the opposite of "this engine has no such concept".
          phi: rating.engine === 'GLICKO2' ? new Prisma.Decimal(rating.state.phi) : null,
          sigma: new Prisma.Decimal(rating.state.sigma),
          displayRating: new Prisma.Decimal(displayFor(rating)),
          // openskill has no match counter of its own, and Glicko's is internal
          // to its own state. Counting here — from the previous ROW — is the one
          // definition that is true for both engines.
          matchesPlayed: (playedBefore.get(userId) ?? 0) + 1,
        },
      });

      deltas.set(userId, { before: displayFor(previous), after: displayFor(rating) });
    }
  });

  // XP for turning up and playing. Keyed on the match, so a redelivered result
  // cannot pay twice — though the gate above already stopped us getting here.
  for (const userId of players) {
    await awardXp(db, {
      tenantId: input.tenantId,
      userId,
      type: 'MATCH_PLAYED',
      dedupeKey: `match_played:${input.dedupeKey}:${userId}`,
      refType: 'match',
      refId: input.dedupeKey,
    });
  }

  return { recorded: true, ratings: deltas };
}

/** How many matches this player has already had rated in this sport. */
async function matchesPlayedFor(
  db: PrismaClient,
  userId: string,
  sport: SportType,
): Promise<number> {
  const latest = await db.skillRatingHistory.findFirst({
    where: { userId, sport },
    orderBy: { computedAt: 'desc' },
    select: { matchesPlayed: true },
  });

  return latest?.matchesPlayed ?? 0;
}

// ══ Dashboards ═══════════════════════════════════════════════════════

export interface PlayerSportStats {
  sport: SportType;
  engine: 'GLICKO2' | 'OPENSKILL';
  displayRating: number;
  matchesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  /** Oldest → newest, for a sparkline. */
  trend: Array<{ at: Date; rating: number }>;
}

/**
 * A player's performance dashboard for one sport.
 *
 * Win/loss is computed from `match_result` rather than stored on a counter, for
 * the same reason XP is a sum: a counter has to be kept in step by every code
 * path that ever writes one, and the day it disagrees with the results there is
 * no way to say which is right.
 */
export async function playerStats(
  db: PrismaClient,
  input: { userId: string; sport: SportType; trendLimit?: number },
): Promise<PlayerSportStats> {
  const trendLimit = Math.min(input.trendLimit ?? 30, 100);

  // guardrail-allow: cross-tenant — a player's rating and record are THEIRS and
  // follow them between clubs, exactly like their XP (P18). Scoping to one
  // tenant would show a different rating on every venue's page.
  const [history, tally] = await Promise.all([
    db.skillRatingHistory.findMany({
      where: { userId: input.userId, sport: input.sport },
      orderBy: { computedAt: 'desc' },
      take: trendLimit,
    }),
    // Indexed on exactly this: (userId, sport, recordedAt). One grouped count,
    // rather than fetching matches and scanning them in JavaScript.
    //
    // guardrail-allow: cross-tenant — see the note above: a rating follows the
    // player between clubs. Scoping the win/loss tally to one tenant would
    // show a different record on every venue's page.
    db.matchParticipant.groupBy({
      by: ['outcome'],
      where: { userId: input.userId, sport: input.sport },
      _count: { _all: true },
    }),
  ]);

  const current = history[0];

  const countOf = (outcome: 'WIN' | 'LOSS' | 'DRAW') =>
    tally.find((t) => t.outcome === outcome)?._count._all ?? 0;

  const wins = countOf('WIN');
  const losses = countOf('LOSS');
  const draws = countOf('DRAW');

  const played = wins + losses + draws;

  return {
    sport: input.sport,
    engine: current?.engine ?? engineFor(input.sport),
    displayRating: current ? Number(current.displayRating) : displayFor(newRatingFor(input.sport)),
    matchesPlayed: played,
    wins,
    losses,
    draws,
    // Draws count in the denominator. A 50% win rate over ten games where eight
    // were draws is not the same player as one who won five and lost five.
    winRate: played > 0 ? Math.round((wins / played) * 1000) / 10 : 0,
    trend: history
      .slice()
      .reverse()
      .map((h) => ({ at: h.computedAt, rating: Number(h.displayRating) })),
  };
}
