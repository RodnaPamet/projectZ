import type { SportType } from '@prisma/client';

import { SPORTS } from '@/lib/sports/registry';

/**
 * WHAT A SCORE LOOKS LIKE, PER SPORT (#575, decision 46).
 *
 * A score is a list of pairs, side 0 first: `[[6,4],[3,6],[7,5]]`. What the
 * pairs mean follows the sport's own scoring in the registry:
 *
 *   PERIODS  sets and games, or games and points: every racket sport, and
 *            volleyball. One to five periods, none tied; the side that won
 *            more periods won.
 *   TOTAL    one pair: goals (football, handball), points (basketball), a
 *            game (chess, esports). A draw is a result where the sport has
 *            them; basketball does not.
 *   ORDER    a finishing order, entered by the track (karting, decision 33):
 *            no score at all.
 *   NONE     nothing to report: running and cycling have no sides.
 */
export type ScoreFormat = 'PERIODS' | 'TOTAL' | 'ORDER' | 'NONE';

export type Score = number[][];

export function scoreFormatFor(sport: SportType): ScoreFormat {
  const { family, scoring } = SPORTS[sport];
  if (scoring === 'TIME_DISTANCE') return 'NONE';
  if (family === 'MOTORSPORT') return 'ORDER';
  if (family === 'RACKET' || scoring === 'SETS') return 'PERIODS';
  return 'TOTAL';
}

/** Whether a level score is a result: goals and chess, not basketball or a set. */
export function drawAllowed(sport: SportType): boolean {
  const { scoring } = SPORTS[sport];
  return (
    scoreFormatFor(sport) === 'TOTAL' &&
    (scoring === 'GOALS' || scoring === 'CHESS' || scoring === 'CUSTOM')
  );
}

export const MAX_PERIODS = 5;
/** Games in a set or points in a game: generous, and never a typing slip of 600. */
export const MAX_IN_PERIOD = 99;
/** Goals or points in a whole match. */
export const MAX_TOTAL = 300;

export class InvalidScoreError extends Error {
  constructor(readonly reason: string) {
    super(`That score cannot be right: ${reason}.`);
    this.name = 'InvalidScoreError';
  }
}

const isCount = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;

/**
 * Which side won `score` in `sport`: 0, 1, or null for a draw. Throws
 * `InvalidScoreError` for a score that cannot be a result of that sport.
 */
export function winnerOf(sport: SportType, score: unknown): 0 | 1 | null {
  const format = scoreFormatFor(sport);
  if (format === 'ORDER' || format === 'NONE') {
    throw new InvalidScoreError('this sport has no score to report');
  }
  if (!Array.isArray(score) || score.length === 0) {
    throw new InvalidScoreError('there is no score');
  }
  const max = format === 'PERIODS' ? MAX_IN_PERIOD : MAX_TOTAL;
  const pairs = score.map((p) => {
    if (!Array.isArray(p) || p.length !== 2 || !isCount(p[0], max) || !isCount(p[1], max)) {
      throw new InvalidScoreError('each part is two whole numbers');
    }
    return [p[0], p[1]] as const;
  });

  if (format === 'TOTAL') {
    if (pairs.length !== 1) throw new InvalidScoreError('the score is one pair');
    const [a, b] = pairs[0]!;
    if (a === b) {
      if (!drawAllowed(sport)) throw new InvalidScoreError('this sport has no draws');
      return null;
    }
    return a > b ? 0 : 1;
  }

  if (pairs.length > MAX_PERIODS) throw new InvalidScoreError(`at most ${MAX_PERIODS} sets`);
  let won0 = 0;
  let won1 = 0;
  for (const [a, b] of pairs) {
    if (a === b) throw new InvalidScoreError('a set is never level');
    if (a > b) won0++;
    else won1++;
  }
  if (won0 === won1) throw new InvalidScoreError('one side has to win more sets');
  return won0 > won1 ? 0 : 1;
}
