import { engineFor } from '@/lib/ratings/engine';
import { levelOf, meanForLevel, seedRating } from '@/lib/ratings/levels';

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
