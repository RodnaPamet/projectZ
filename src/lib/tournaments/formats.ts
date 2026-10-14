import {
  type Pairing,
  type ReportedResult,
  type Standing,
  type TournamentFormat,
  type TournamentFormatKind,
  type TournamentPlayer,
} from './format';
import { computeStandings } from './standings';
import { Swiss } from './swiss';

/**
 * The formats themselves.
 *
 * ─── Which of these we wrote, and why ────────────────────────────────
 *
 * ROUND ROBIN and SINGLE ELIMINATION are ours. The circle method and a bracket
 * are short, fully determined, and easy to test exhaustively. Taking a
 * bus-factor-1 dependency to compute "everyone plays everyone" would be paying
 * a real risk for no benefit.
 *
 * SWISS is delegated to `tournament-organizer` (MIT). Swiss pairing done
 * PROPERLY — score groups, no rematches, colour balance, Buchholz tiebreaks —
 * is genuinely hard, and a naive implementation is subtly wrong in ways nobody
 * notices until round four of a real event. That library does it well.
 *
 * Both sit behind the same `TournamentFormat` interface, so the split is
 * invisible to every caller. If the library is abandoned, only the Swiss adapter
 * needs replacing — which is the entire point of the wrapper.
 */

// ══ Round robin ══════════════════════════════════════════════════════

/**
 * The circle method. Everyone plays everyone, exactly once.
 *
 * One player is pinned and the rest rotate around them. With an odd field a
 * phantom "BYE" is added, and whoever is drawn against it sits that round out —
 * which is why `away` is nullable.
 */
export class RoundRobin implements TournamentFormat {
  readonly kind: TournamentFormatKind = 'ROUND_ROBIN';

  roundsFor(playerCount: number): number {
    if (playerCount < 2) return 0;
    // An odd field needs n rounds (each player sits out once); an even one n-1.
    return playerCount % 2 === 0 ? playerCount - 1 : playerCount;
  }

  pair(input: { players: TournamentPlayer[]; round: number }): Pairing[] {
    const ids = input.players.map((p) => p.id);
    if (ids.length < 2) return [];

    // The phantom. Its opponent gets the bye.
    const field = ids.length % 2 === 0 ? [...ids] : [...ids, BYE];
    const n = field.length;

    const rounds = this.roundsFor(input.players.length);
    if (input.round < 1 || input.round > rounds) return [];

    // Rotate: element 0 is fixed, the rest shift by (round - 1).
    const rotated = [field[0]!, ...rotate(field.slice(1), input.round - 1)];

    const pairings: Pairing[] = [];
    for (let i = 0; i < n / 2; i++) {
      const home = rotated[i]!;
      const away = rotated[n - 1 - i]!;

      if (home === BYE) {
        pairings.push({ round: input.round, home: away, away: null });
      } else if (away === BYE) {
        pairings.push({ round: input.round, home, away: null });
      } else {
        pairings.push({ round: input.round, home, away });
      }
    }

    return pairings;
  }

  standings(input: { players: TournamentPlayer[]; results: ReportedResult[] }): Standing[] {
    return computeStandings(input.players, input.results);
  }
}

const BYE = '__BYE__';

function rotate<T>(arr: T[], by: number): T[] {
  if (arr.length === 0) return arr;
  const k = ((by % arr.length) + arr.length) % arr.length;
  return [...arr.slice(-k || arr.length), ...arr.slice(0, -k || arr.length)].slice(0, arr.length);
}

// ══ Single elimination ═══════════════════════════════════════════════

/**
 * A knockout bracket, seeded so the top seeds meet as LATE as possible.
 *
 * The field is padded to a power of two with byes, and the byes go to the TOP
 * seeds. That is not a favour to them: a bracket where the first seed is knocked
 * out in round one by an accident of an odd field size is not a tournament, it
 * is a raffle.
 */
export class SingleElimination implements TournamentFormat {
  readonly kind: TournamentFormatKind = 'SINGLE_ELIMINATION';

  roundsFor(playerCount: number): number {
    if (playerCount < 2) return 0;
    return Math.ceil(Math.log2(playerCount));
  }

  pair(input: {
    players: TournamentPlayer[];
    round: number;
    results: ReportedResult[];
  }): Pairing[] {
    const seeded = [...input.players].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    if (seeded.length < 2) return [];

    if (input.round === 1) {
      const size = 2 ** this.roundsFor(seeded.length);
      const slots: (string | null)[] = seedOrder(size).map((seed) => seeded[seed - 1]?.id ?? null);

      const pairings: Pairing[] = [];
      for (let i = 0; i < size; i += 2) {
        const home = slots[i];
        const away = slots[i + 1];

        if (!home && !away) continue;
        if (!home || !away) {
          // A bye. It goes to whoever is actually there.
          pairings.push({ round: 1, home: (home ?? away)!, away: null });
        } else {
          pairings.push({ round: 1, home, away });
        }
      }
      return pairings;
    }

    // Later rounds: pair the winners of the previous round, in bracket order.
    const previous = input.results.filter((r) => r.round === input.round - 1);
    const byes = this.pair({
      players: input.players,
      round: input.round - 1,
      results: input.results,
    })
      .filter((p) => p.away === null)
      .map((p) => p.home);

    const winners = [
      ...previous.map((r) => (r.homeScore > r.awayScore ? r.home : r.away)),
      ...byes,
    ];

    const pairings: Pairing[] = [];
    for (let i = 0; i < winners.length; i += 2) {
      const home = winners[i]!;
      const away = winners[i + 1] ?? null;
      pairings.push({ round: input.round, home, away });
    }

    return pairings;
  }

  standings(input: { players: TournamentPlayer[]; results: ReportedResult[] }): Standing[] {
    return computeStandings(input.players, input.results);
  }
}

/**
 * Standard bracket seeding: 1 plays the lowest, 2 plays the second lowest, and
 * the top two seeds can only meet in the final.
 *
 * For 8: [1, 8, 4, 5, 2, 7, 3, 6].
 */
export function seedOrder(size: number): number[] {
  let order = [1, 2];

  while (order.length < size) {
    const next: number[] = [];
    const rounds = order.length * 2 + 1;

    for (const seed of order) {
      next.push(seed, rounds - seed);
    }
    order = next;
  }

  return order;
}

// ══ Swiss (delegated) ════════════════════════════════════════════════

export { Swiss } from './swiss';
export { computeStandings } from './standings';

// ══ The registry ═════════════════════════════════════════════════════

export function formatFor(kind: TournamentFormatKind): TournamentFormat {
  switch (kind) {
    case 'ROUND_ROBIN':
      return new RoundRobin();
    case 'SINGLE_ELIMINATION':
      return new SingleElimination();
    case 'SWISS':
      return new Swiss();
    case 'DOUBLE_ELIMINATION':
      throw new Error(
        'Double elimination is not implemented. It needs a losers bracket, and a ' +
          'half-built one that silently drops a player is worse than not offering it.',
      );
    case 'GROUPS_KNOCKOUT':
    case 'AMERICANO':
    case 'MEXICANO':
    case 'LEAGUE':
      // A club can create these (#579); drawing them is #580.
      throw new Error(`The ${kind} draw is not built yet (#580).`);
  }
}
