import { engineFor } from '@/lib/ratings/engine';
import {
  isProvisional,
  levelOf,
  levelOfMean,
  meanForLevel,
  PROVISIONAL_AFTER_DAYS,
  seedRating,
  withInactivity,
} from '@/lib/ratings/levels';

/**
 * THE 1–7 LEVEL AND THE ENGINES (#378, decisions 31 and Q24).
 *
 * A rating starts at the level the player declared, with full uncertainty,
 * and is shown on the same 1–7 scale whatever engine is behind it.
 */
describe('ratings on the 1–7 level scale', () => {
  it('padel is OpenSkill and chess is Glicko-2, the two scales this maps', () => {
    expect(engineFor('PADEL')).toBe('OPENSKILL');
    expect(engineFor('CHESS')).toBe('GLICKO2');
  });

  it.each([
    ['PADEL', 1, 13],
    ['PADEL', 4, 25],
    ['PADEL', 7, 37],
    ['CHESS', 1, 900],
    ['CHESS', 4, 1500],
    ['CHESS', 7, 2100],
  ] as const)('%s declared %i starts at a mean of %i', (sport, level, mean) => {
    const rating = seedRating(sport, level);
    expect(rating.state.mu).toBe(mean);
    expect(meanForLevel(rating.engine, level)).toBe(mean);
  });

  it('starts with the engine’s full uncertainty, whatever the level', () => {
    expect(seedRating('PADEL', 6).state.sigma).toBe(seedRating('PADEL', 2).state.sigma);
    const chess = seedRating('CHESS', 6);
    expect(chess.engine === 'GLICKO2' && chess.state.phi).toBe(350);
  });

  it('with no declared level, starts in the middle', () => {
    expect(levelOf(seedRating('TENNIS', null))).toBe(4);
    expect(levelOf(seedRating('CHESS', undefined))).toBe(4);
  });

  it('shows a seeded rating at the level it was declared', () => {
    for (const level of [1, 2, 3, 4, 5, 6, 7]) {
      expect(levelOf(seedRating('SQUASH', level))).toBe(level);
      expect(levelOf(seedRating('CHESS', level))).toBe(level);
    }
  });

  it('shows one decimal, and never leaves 1–7', () => {
    const between = seedRating('PADEL', 4);
    between.state.mu = 26.2; // 4 + 1.2/4 = 4.3
    expect(levelOf(between)).toBe(4.3);

    const above = seedRating('PADEL', 7);
    above.state.mu = 99;
    expect(levelOf(above)).toBe(7);
    const below = seedRating('CHESS', 1);
    below.state.mu = 100;
    expect(levelOf(below)).toBe(1);
  });

  it('a declared level outside 1–7 is held to the scale', () => {
    expect(levelOf(seedRating('PADEL', 12))).toBe(7);
    expect(levelOf(seedRating('PADEL', -3))).toBe(1);
  });
});

describe('provisional, and time away (decisions 47, 48)', () => {
  const now = new Date('2026-10-14T12:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  it('is provisional under 5 matches, settled from 5, and provisional again after six months away', () => {
    expect(isProvisional(0, null, now)).toBe(true);
    expect(isProvisional(4, daysAgo(1), now)).toBe(true);
    expect(isProvisional(5, daysAgo(1), now)).toBe(false);
    expect(isProvisional(40, daysAgo(PROVISIONAL_AFTER_DAYS), now)).toBe(false);
    expect(isProvisional(40, daysAgo(PROVISIONAL_AFTER_DAYS + 1), now)).toBe(true);
  });

  it('time away leaves the mean, and so the level, where it was', () => {
    const settled = { engine: 'OPENSKILL' as const, state: { mu: 31, sigma: 2.5 } };
    const back = withInactivity(settled, daysAgo(200), now);
    expect(back.state.mu).toBe(31);
    expect(levelOf(back)).toBe(levelOf(settled));
  });

  it('…and grows the uncertainty, slowly, to a newcomer’s after a year and never past it', () => {
    const settled = { engine: 'OPENSKILL' as const, state: { mu: 31, sigma: 2.5 } };
    const newcomer = seedRating('PADEL', 4).state.sigma;
    const month = withInactivity(settled, daysAgo(30), now).state.sigma;
    const year = withInactivity(settled, daysAgo(365), now).state.sigma;
    const decade = withInactivity(settled, daysAgo(3650), now).state.sigma;
    expect(month).toBeGreaterThan(2.5);
    expect(month).toBeLessThan(year);
    expect(year).toBeCloseTo(newcomer, 5);
    expect(decade).toBeCloseTo(newcomer, 5);
    // No time, no change.
    expect(withInactivity(settled, now, now)).toEqual(settled);
  });

  it('Glicko-2 grows φ the same way, to 350', () => {
    const chess = {
      engine: 'GLICKO2' as const,
      state: { mu: 1700, phi: 70, sigma: 0.06, matchesPlayed: 30 },
    };
    const back = withInactivity(chess, daysAgo(365), now);
    expect(back.state.mu).toBe(1700);
    expect(back.engine === 'GLICKO2' && back.state.phi).toBeCloseTo(350, 5);
  });

  it('a stored mean reads as the same level as the rating it came from', () => {
    expect(levelOfMean('OPENSKILL', 27)).toBe(
      levelOf({ engine: 'OPENSKILL', state: { mu: 27, sigma: 3 } }),
    );
    expect(levelOfMean('GLICKO2', 1600)).toBe(4.5);
  });
});
