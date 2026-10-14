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
  return levelOfMean(rating.engine, rating.state.mu);
}

/** The level an engine's mean reads as, as `levelOf`, from a stored row's `mu`. */
export function levelOfMean(engine: RatingEngine, mu: number): number {
  const { centre, perLevel } = SCALE[engine];
  const raw = CENTRE_LEVEL + (mu - centre) / perLevel;
  return Math.round(clampLevel(raw) * 10) / 10;
}

// ── Provisional, and away (decisions 47, 48) ─────────────────────────────

/** A level is provisional until this many confirmed matches (decision 47). */
export const PROVISIONAL_MATCHES = 5;

/**
 * …and again after this long without one (decision 48: "after months without
 * results the level is provisional again"). Six months, our reading of
 * "months"; a constant to tune, not a promise in the copy.
 */
export const PROVISIONAL_AFTER_DAYS = 180;

/**
 * A year away brings a settled player back to a newcomer's uncertainty. The
 * growth is a variance added per day, so it starts slow and is capped at the
 * engine's starting uncertainty: OpenSkill σ 8.33 (from about 2.5, settled),
 * Glicko-2 φ 350 (from about 70).
 */
const AWAY_FULL_DAYS = 365;
const SETTLED: Record<RatingEngine, number> = { OPENSKILL: 2.5, GLICKO2: 70 };
const DAY_MS = 86_400_000;

/** Whether a level is provisional: too few matches, or too long since the last. */
export function isProvisional(matchesPlayed: number, lastAt: Date | null, now: Date): boolean {
  if (matchesPlayed < PROVISIONAL_MATCHES || !lastAt) return true;
  return now.getTime() - lastAt.getTime() > PROVISIONAL_AFTER_DAYS * DAY_MS;
}

/**
 * A rating after a time away (decision 48): the mean, and so the level, stays;
 * the uncertainty grows, so the next results move it faster. Never past a
 * newcomer's uncertainty.
 */
export function withInactivity(rating: SportRating, lastAt: Date, now: Date): SportRating {
  const days = Math.max(0, (now.getTime() - lastAt.getTime()) / DAY_MS);
  if (days === 0) return rating;
  const full = rating.engine === 'GLICKO2' ? defaultRating().phi : newRating().sigma;
  const perDay = (full * full - SETTLED[rating.engine] ** 2) / AWAY_FULL_DAYS;
  const grow = (u: number) => Math.min(Math.max(u, full), Math.sqrt(u * u + perDay * days));
  if (rating.engine === 'GLICKO2') {
    return { engine: 'GLICKO2', state: { ...rating.state, phi: grow(rating.state.phi) } };
  }
  return { engine: 'OPENSKILL', state: { ...rating.state, sigma: grow(rating.state.sigma) } };
}
