import type { Random } from './draw';
import { RoundRobin } from './formats';

/**
 * AMERICANO AND MEXICANO, AS DATA (#590; decisions 43, 56, 60 on #378).
 *
 * Players sign up alone; every match is two against two, on as many courts
 * as the round needs, and anyone left over sits the round out.
 *
 *   Americano  every round written at the draw: partners rotate so that
 *              nobody partners anybody twice while it can be helped, and
 *              opponents repeat as little as they can; the rounds off go to
 *              whoever has had the fewest
 *   Mexicano   one round at a time: the first by level, then from the table,
 *              in fours down it, the 1st and 4th against the 2nd and 3rd
 *   the table  each player keeps the points their pair won (56); ties by the
 *              points difference, then matches won. No ratings (43).
 */

export interface PairMatch {
  round: number;
  slot: number;
  a: [string, string];
  b: [string, string];
}

const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);

function shuffle<T>(items: readonly T[], random: Random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Who sits this round out: the fewest rounds off so far first; ties at random. */
function sitters(
  players: readonly string[],
  off: Map<string, number>,
  random: Random,
): Set<string> {
  const extra = players.length % 4;
  if (extra === 0) return new Set();
  const order = shuffle(players, random).sort((x, y) => (off.get(x) ?? 0) - (off.get(y) ?? 0));
  return new Set(order.slice(0, extra));
}

/** Every Americano round (60): partners rotated, opponents spread, rounds off shared. */
export function americano(players: readonly string[], rounds: number, random: Random): PairMatch[] {
  const partnered = new Map<string, number>();
  const opposed = new Map<string, number>();
  const off = new Map<string, number>();
  const out: PairMatch[] = [];
  // One random order for the whole event: the circle method rotates it.
  const fixed = shuffle(players, random);
  const count = (m: Map<string, number>, x: string, y: string) => m.get(pairKey(x, y)) ?? 0;
  const bump = (m: Map<string, number>, x: string, y: string) =>
    m.set(pairKey(x, y), count(m, x, y) + 1);

  for (let round = 1; round <= rounds; round++) {
    const out_ = sitters(players, off, random);
    for (const p of out_) off.set(p, (off.get(p) ?? 0) + 1);
    const playing = shuffle(
      players.filter((p) => !out_.has(p)),
      random,
    );

    // Pairs. With nobody off (a multiple of four), the circle method: over
    // n-1 rounds everyone partners everyone exactly once. Otherwise each
    // takes the partner it has partnered least.
    const pairs: Array<[string, string]> = [];
    if (out_.size === 0) {
      const circle = new RoundRobin();
      const r = ((round - 1) % circle.roundsFor(fixed.length)) + 1;
      for (const p of circle.pair({ players: fixed.map((id) => ({ id })), round: r })) {
        if (p.away) pairs.push([p.home, p.away]);
      }
    } else {
      const left = [...playing];
      while (left.length >= 2) {
        const x = left.shift()!;
        let best = 0;
        for (let i = 1; i < left.length; i++) {
          if (count(partnered, x, left[i]!) < count(partnered, x, left[best]!)) best = i;
        }
        const [y] = left.splice(best, 1);
        pairs.push([x, y!]);
      }
    }
    // Matches: each pair meets the pair it has opposed least.
    const opposition = (p: [string, string], q: [string, string]) =>
      p.reduce((n, x) => n + q.reduce((k, y) => k + count(opposed, x, y), 0), 0);
    const pool = [...pairs];
    let slot = 0;
    while (pool.length >= 2) {
      const p = pool.shift()!;
      let best = 0;
      for (let i = 1; i < pool.length; i++) {
        if (opposition(p, pool[i]!) < opposition(p, pool[best]!)) best = i;
      }
      const [q] = pool.splice(best, 1);
      out.push({ round, slot: slot++, a: p, b: q! });
      bump(partnered, p[0], p[1]);
      bump(partnered, q![0], q![1]);
      for (const x of p) for (const y of q!) bump(opposed, x, y);
    }
  }
  return out;
}

/**
 * One Mexicano round from a ranking, best first (60): the rounds off to
 * whoever has had the fewest (the lowest-ranked of them), then fours down the
 * table, the 1st and 4th against the 2nd and 3rd.
 */
export function mexicanoRound(
  ranked: readonly string[],
  round: number,
  off: ReadonlyMap<string, number>,
): PairMatch[] {
  const extra = ranked.length % 4;
  const restOrder = [...ranked]
    .map((p, i) => ({ p, i }))
    .sort((x, y) => (off.get(x.p) ?? 0) - (off.get(y.p) ?? 0) || y.i - x.i)
    .slice(0, extra)
    .map((x) => x.p);
  const playing = ranked.filter((p) => !restOrder.includes(p));
  const out: PairMatch[] = [];
  for (let i = 0; i + 3 < playing.length; i += 4) {
    const [p1, p2, p3, p4] = playing.slice(i, i + 4) as [string, string, string, string];
    out.push({ round, slot: i / 4, a: [p1, p4], b: [p2, p3] });
  }
  return out;
}

export interface PointsMatch {
  a: [string, string];
  b: [string, string];
  /** Side A's points, side B's. Null for a walkover: a win, no points. */
  score: [number, number] | null;
  winnerSide: 0 | 1 | null;
}

export interface PointsRow {
  entryId: string;
  rank: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  /** The points their pairs won (56). */
  points: number;
  /** Points won minus points lost. */
  diff: number;
}

/** The table (56): points won, then the points difference, then matches won. */
export function pointsTable(
  players: readonly string[],
  matches: readonly PointsMatch[],
): PointsRow[] {
  const rows = new Map<string, PointsRow>(
    players.map((id) => [
      id,
      { entryId: id, rank: 0, played: 0, won: 0, drawn: 0, lost: 0, points: 0, diff: 0 },
    ]),
  );
  for (const m of matches) {
    const sides = [m.a, m.b] as const;
    sides.forEach((side, i) => {
      for (const id of side) {
        const r = rows.get(id);
        if (!r) continue;
        r.played++;
        if (m.winnerSide === null) r.drawn++;
        else if (m.winnerSide === i) r.won++;
        else r.lost++;
        if (m.score) {
          const mine = m.score[i]!;
          const theirs = m.score[1 - i]!;
          r.points += mine;
          r.diff += mine - theirs;
        }
      }
    });
  }
  const sorted = [...rows.values()].sort(
    (x, y) =>
      y.points - x.points || y.diff - x.diff || y.won - x.won || (x.entryId < y.entryId ? -1 : 1),
  );
  sorted.forEach((r, i) => (r.rank = i + 1));
  return sorted;
}

/** A points match's score (56): one pair adding up to the match's points. Which side won, or a draw. */
export function pointsWinner(score: unknown, total: number): 0 | 1 | null {
  if (!Array.isArray(score) || score.length !== 1)
    throw new PointsScoreError('the score is one pair');
  const pair = score[0];
  if (!Array.isArray(pair) || pair.length !== 2)
    throw new PointsScoreError('the score is one pair');
  const [a, b] = pair as unknown[];
  if (!Number.isInteger(a) || !Number.isInteger(b) || (a as number) < 0 || (b as number) < 0) {
    throw new PointsScoreError('points are whole numbers');
  }
  if ((a as number) + (b as number) !== total)
    throw new PointsScoreError(`a match is played to ${total} points`);
  return a === b ? null : (a as number) > (b as number) ? 0 : 1;
}

export class PointsScoreError extends Error {
  constructor(readonly reason: string) {
    super(`That score cannot be right: ${reason}.`);
    this.name = 'InvalidScoreError';
  }
}
