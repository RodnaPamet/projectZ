import type { SportType } from '@prisma/client';

import { defaultRating } from '@/lib/matchmaking/glicko';
import { MAX_SPORT_LEVEL, MIN_SPORT_LEVEL } from '@/lib/profile/limits';

import { engineFor, type RatingEngine, type SportRating } from './engine';
import { newRating } from './openskill';

/**
 * THE 1–7 LEVEL, AND THE ENGINES BEHIND IT (#378, decisions 31 and Q24).
 *
 * A player declares a level from 1 to 7 per sport (#359). Ratings start there
 * and move with results, and everyone sees the result on the same 1–7 scale:
 * on the profile, in open play, on a coach's page. The engine's own number
 * ("points") is shown on the player's own page only.
 *
 * One level is a fixed step of the engine's mean, around its centre at level
 * 4:
 *
 *   OpenSkill (every sport with sides, and karting's race)  25 ± 4 a level
 *   Glicko-2  (chess)                                     1500 ± 200 a level
 *
 * A new player starts at the mean their declared level gives, with the
 * engine's full uncertainty: the first results move them quickly, and nobody
 * is held at a level they only claimed. The level shown is read off the MEAN,
 * not the conservative figure the points use; how settled it is shows as
 * "provisional" instead (decision 47), so a newcomer who said 5 is shown 5,
 * marked provisional, rather than 1.
 */

const CENTRE_LEVEL = 4;

const SCALE: Record<RatingEngine, { centre: number; perLevel: number }> = {
  OPENSKILL: { centre: 25, perLevel: 4 },
  GLICKO2: { centre: 1500, perLevel: 200 },
};

/** A level kept inside 1–7. */
function clampLevel(level: number): number {
  return Math.min(MAX_SPORT_LEVEL, Math.max(MIN_SPORT_LEVEL, level));
}

/** The engine mean a declared level starts from. */
export function meanForLevel(engine: RatingEngine, level: number): number {
  const { centre, perLevel } = SCALE[engine];
  return centre + (clampLevel(level) - CENTRE_LEVEL) * perLevel;
}

/**
 * A first rating for `sport`: at the declared level when there is one, at the
 * centre when there is none. Full uncertainty either way.
 */
export function seedRating(sport: SportType, declaredLevel?: number | null): SportRating {
  const engine = engineFor(sport);
  const level = declaredLevel ?? CENTRE_LEVEL;
  if (engine === 'GLICKO2') {
    return { engine, state: { ...defaultRating(), mu: meanForLevel(engine, level) } };
  }
  return { engine, state: { ...newRating(), mu: meanForLevel(engine, level) } };
}

/** The level to show, one decimal, 1–7: «Ниво 4,3». */
export function levelOf(rating: SportRating): number {
  const { centre, perLevel } = SCALE[rating.engine];
  const raw = CENTRE_LEVEL + (rating.state.mu - centre) / perLevel;
  return Math.round(clampLevel(raw) * 10) / 10;
}
