import { RoundRobin, seedOrder } from './formats';

/**
 * A CLUB TOURNAMENT'S DRAW, AS DATA (#580; decisions 54, 55, 57, 61 on #378).
 *
 * Pure: entries in, the matches to create out. The use case writes them and
 * moves winners along; this file decides who meets whom.
 *
 *   knockout     the field padded to a power of two; the highest-rated
 *                entries seeded apart, as many as a quarter of the draw or as
 *                the byes need, and the byes go to them (54); the rest drawn
 *                at random. Every match of every round exists from the start,
 *                each pointing at the match its winner goes on to; with a
 *                third-place match (61), the semi-final losers go to it.
 *   groups       entries spread over the club's number of groups by level, in
 *                a snake (55); everyone in a group plays everyone (the circle
 *                method). The top of each group then goes into a knockout,
 *                group winners seeded apart and no group's two qualifiers
 *                meeting in the first round where it can be helped.
 *   tables       a win 3, a draw 1, a loss 0 (57); ties by head-to-head, then
 *                sets or goals difference, then games difference.
 */

export interface DrawEntry {
  id: string;
  /** Higher is stronger: the mean of the entry's rating, frozen at the draw. */
  strength: number;
}

/** A match to create. `slot` orders the matches of a round; side B null in round 1 is a bye. */
export interface MatchSpec {
  key: string;
  stage: 'GROUP' | 'KNOCKOUT' | 'THIRD_PLACE';
  round: number;
  slot: number;
  /** 1.. for a group's matches; 0 for a knockout's. */
  groupNo: number;
  entryA: string | null;
  entryB: string | null;
  /** The match the winner goes to, and on which side. */
  next: { key: string; side: 0 | 1 } | null;
  /** The match the loser goes to: a semi-final's, the third-place match. */
  loserNext: { key: string; side: 0 | 1 } | null;
}

/** A random number in [0, 1): injected so a draw can be tested. */
export type Random = () => number;

function shuffle<T>(items: readonly T[], random: Random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const byStrength = (a: DrawEntry, b: DrawEntry) =>
  b.strength - a.strength || (a.id < b.id ? -1 : 1);

/** The smallest power of two that holds `n`, and at least 2. */
export function bracketSize(n: number): number {
  let size = 2;
  while (size < n) size *= 2;
  return size;
}

/**
 * Seed numbers 1..n for a knockout (54): the strongest `seeded` in order, the
 * rest in a random order after them. The seeds are as many as a quarter of
 * the draw, or as the byes need, whichever is more: the byes go to the top.
 */
export function seedEntries(entries: readonly DrawEntry[], random: Random): DrawEntry[] {
  const sorted = [...entries].sort(byStrength);
  const size = bracketSize(sorted.length);
  const byes = size - sorted.length;
  const seeded = Math.min(sorted.length, Math.max(2, size / 4, byes));
  return [...sorted.slice(0, seeded), ...shuffle(sorted.slice(seeded), random)];
}

/**
 * Every match of a knockout, in order: entries by seed (seed 1 first), byes
 * where the field is short. Round 1's byes are matches with one side; the
 * use case sends that side straight on.
 */
export function knockout(
  seeded: readonly (string | null)[],
  opts: { thirdPlace: boolean; keyPrefix?: string } = { thirdPlace: false },
): MatchSpec[] {
  const prefix = opts.keyPrefix ?? 'ko';
  const size = bracketSize(seeded.length);
  const rounds = Math.log2(size);
  const order = seedOrder(size).map((seed) => seeded[seed - 1] ?? null);
  const specs: MatchSpec[] = [];
  const key = (round: number, slot: number) => `${prefix}:${round}:${slot}`;

  for (let round = 1; round <= rounds; round++) {
    const matches = size / 2 ** round;
    for (let slot = 0; slot < matches; slot++) {
      specs.push({
        key: key(round, slot),
        stage: 'KNOCKOUT',
        round,
        slot,
        groupNo: 0,
        entryA: round === 1 ? order[slot * 2]! : null,
        entryB: round === 1 ? order[slot * 2 + 1]! : null,
        next:
          round < rounds
            ? { key: key(round + 1, Math.floor(slot / 2)), side: (slot % 2) as 0 | 1 }
            : null,
        loserNext: null,
      });
    }
  }

  // The semi-final losers play for third (61): only a draw with semi-finals.
  if (opts.thirdPlace && rounds >= 2) {
    const third = `${prefix}:third`;
    specs.push({
      key: third,
      stage: 'THIRD_PLACE',
      round: rounds,
      slot: 1,
      groupNo: 0,
      entryA: null,
      entryB: null,
      next: null,
      loserNext: null,
    });
    for (const s of specs) {
      if (s.stage === 'KNOCKOUT' && s.round === rounds - 1)
        s.loserNext = { key: third, side: s.slot as 0 | 1 };
    }
  }
  return specs;
}

/** Entries spread over `count` groups by level, in a snake (55): 1 2 3 3 2 1 1 2 3… */
export function snakeGroups(entries: readonly DrawEntry[], count: number): string[][] {
  const groups: string[][] = Array.from({ length: count }, () => []);
  [...entries].sort(byStrength).forEach((e, i) => {
    const lap = Math.floor(i / count);
    const at = i % count;
    groups[lap % 2 === 0 ? at : count - 1 - at]!.push(e.id);
  });
  return groups;
}

/** Every match of every group: everyone in a group plays everyone, round by round. */
export function groupMatches(groups: readonly string[][]): MatchSpec[] {
  const rr = new RoundRobin();
  const specs: MatchSpec[] = [];
  groups.forEach((members, g) => {
    const groupNo = g + 1;
    const players = members.map((id) => ({ id }));
    for (let round = 1; round <= rr.roundsFor(players.length); round++) {
      let slot = 0;
      for (const p of rr.pair({ players, round })) {
        // A bye in a group is a round off, not a match.
        if (!p.away) continue;
        specs.push({
          key: `g${groupNo}:${round}:${slot}`,
          stage: 'GROUP',
          round,
          slot: slot++,
          groupNo,
          entryA: p.home,
          entryB: p.away,
          next: null,
          loserNext: null,
        });
      }
    }
  });
  return specs;
}

/**
 * The knockout after the groups (55): the qualifiers in seed order, group
 * winners first, then the runners-up, each place in group order. The
 * bracket's seeding pairs seed k with seed size+1-k, so a group's winner
 * meets another group's runner-up in the first round (with an odd number of
 * groups, the middle group's two can meet: the one case it cannot help).
 */
export function qualifiersInSeedOrder(
  standingsByGroup: readonly string[][],
  perGroup: number,
): string[] {
  const out: string[] = [];
  for (let place = 0; place < perGroup; place++) {
    out.push(...standingsByGroup.map((g) => g[place]).filter((x): x is string => !!x));
  }
  return out;
}

// ─── Tables ──────────────────────────────────────────────────────────────

export interface PlayedMatch {
  entryA: string;
  entryB: string;
  /** 0 = A won, 1 = B won, null = a draw. */
  winnerSide: 0 | 1 | null;
  /** Side A's number first in each pair: sets and games, or one total. */
  score: number[][] | null;
  /** A walkover counts as a win and a loss, and nothing in the differences. */
  walkover?: boolean;
}

export interface TableRow {
  entryId: string;
  rank: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  points: number;
  /** Sets won minus lost; for a one-total sport, goals or points. */
  setsDiff: number;
  /** Games won minus lost, in a sport with sets. */
  gamesDiff: number;
}

export const POINTS = { win: 3, draw: 1, loss: 0 } as const;

/**
 * A group's or a round robin's table (57): a win 3, a draw 1, a loss 0; ties
 * by head-to-head among the tied, then sets (or goals) difference, then games
 * difference, then the entry id so the order is stable.
 */
export function table(entryIds: readonly string[], matches: readonly PlayedMatch[]): TableRow[] {
  const rows = new Map<string, TableRow>(
    entryIds.map((id) => [
      id,
      {
        entryId: id,
        rank: 0,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        points: 0,
        setsDiff: 0,
        gamesDiff: 0,
      },
    ]),
  );
  for (const m of matches) {
    const a = rows.get(m.entryA);
    const b = rows.get(m.entryB);
    if (!a || !b) continue;
    a.played++;
    b.played++;
    if (m.winnerSide === null) {
      a.drawn++;
      b.drawn++;
      a.points += POINTS.draw;
      b.points += POINTS.draw;
    } else {
      const [w, l] = m.winnerSide === 0 ? [a, b] : [b, a];
      w.won++;
      l.lost++;
      w.points += POINTS.win;
      l.points += POINTS.loss;
    }
    if (!m.walkover && m.score) {
      const { sets, games } = differences(m.score);
      a.setsDiff += sets;
      b.setsDiff -= sets;
      a.gamesDiff += games;
      b.gamesDiff -= games;
    }
  }

  const headToHead = (x: string, y: string): number => {
    let net = 0;
    for (const m of matches) {
      if (m.winnerSide === null) continue;
      const winner = m.winnerSide === 0 ? m.entryA : m.entryB;
      const loser = m.winnerSide === 0 ? m.entryB : m.entryA;
      if (winner === x && loser === y) net++;
      if (winner === y && loser === x) net--;
    }
    return net;
  };

  const sorted = [...rows.values()].sort(
    (x, y) =>
      y.points - x.points ||
      -headToHead(x.entryId, y.entryId) ||
      y.setsDiff - x.setsDiff ||
      y.gamesDiff - x.gamesDiff ||
      (x.entryId < y.entryId ? -1 : 1),
  );
  sorted.forEach((r, i) => (r.rank = i + 1));
  return sorted;
}

/** Side A's sets (or the total) and games difference, from a score. */
function differences(score: readonly number[][]): { sets: number; games: number } {
  if (score.length === 1) {
    const [a, b] = score[0]!;
    return { sets: a! - b!, games: 0 };
  }
  let sets = 0;
  let games = 0;
  for (const [a, b] of score) {
    sets += a! > b! ? 1 : a! < b! ? -1 : 0;
    games += a! - b!;
  }
  return { sets, games };
}
