/**
 * Tournament formats, behind OUR interface.
 *
 * ─── Why a wrapper, when the library already works ───────────────────
 *
 * `tournament-organizer` is MIT, competent, and maintained by ONE PERSON. That
 * is not a criticism — most good libraries are — but it is a fact worth
 * designing around when the thing it computes is the bracket of a tournament
 * people have paid to enter.
 *
 * If it is abandoned, breaks on a Node upgrade, or changes its pairing semantics
 * in a minor release, the blast radius should be THIS FILE, not every route,
 * component and test that ever touched a bracket.
 *
 * So the rest of the codebase talks to `TournamentFormat` — an interface we own,
 * in vocabulary we chose. The library sits behind it. Replacing it (or writing
 * Swiss pairing ourselves, which is a few hundred lines) becomes a contained
 * job rather than an archaeology project.
 *
 * A ratchet enforces this: nothing outside src/lib/tournaments/ may import
 * `tournament-organizer`.
 */

export type TournamentFormatKind =
  | 'SINGLE_ELIMINATION'
  | 'DOUBLE_ELIMINATION'
  | 'ROUND_ROBIN'
  | 'SWISS'
  // A club's formats (decision 37, P80); their draws are #580's.
  | 'GROUPS_KNOCKOUT'
  | 'AMERICANO'
  | 'MEXICANO'
  | 'LEAGUE';

export interface TournamentPlayer {
  id: string;
  /** Seed / rating. Higher is stronger. Used for pairing, not for scoring. */
  rating?: number;
}

export interface Pairing {
  round: number;
  /** A bye when `away` is null — an odd field has to give somebody a free round. */
  home: string;
  away: string | null;
}

export interface Standing {
  playerId: string;
  rank: number;
  wins: number;
  losses: number;
  draws: number;
  points: number;
  /** Buchholz / opponent strength. The tiebreak that keeps Swiss honest. */
  tiebreak: number;
}

export interface ReportedResult {
  round: number;
  home: string;
  away: string;
  /** Games won by each side. 1-0, or 1.5-0.5 in a two-game match. */
  homeScore: number;
  awayScore: number;
}

/**
 * The contract. Everything outside this directory uses ONLY this.
 */
export interface TournamentFormat {
  readonly kind: TournamentFormatKind;

  /** How many rounds this format needs for N players. */
  roundsFor(playerCount: number): number;

  /** Pair a round, given everything reported so far. */
  pair(input: { players: TournamentPlayer[]; round: number; results: ReportedResult[] }): Pairing[];

  /** Current standings. */
  standings(input: { players: TournamentPlayer[]; results: ReportedResult[] }): Standing[];
}

/** Points, our rules: a win is 1, a draw is a half, a loss is nothing. */
export const POINTS_WIN = 1;
export const POINTS_DRAW = 0.5;
export const POINTS_LOSS = 0;

/**
 * A bye is a WIN, and it must be.
 *
 * With an odd number of players somebody sits out each round. If a bye scored
 * zero, the player who got one would be punished for a scheduling accident they
 * had no part in — and in a Swiss event, where the field is paired by score,
 * that error compounds across every subsequent round.
 */
export const POINTS_BYE = POINTS_WIN;
