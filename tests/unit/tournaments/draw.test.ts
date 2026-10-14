import {
  bracketSize,
  groupMatches,
  knockout,
  qualifiersInSeedOrder,
  seedEntries,
  snakeGroups,
  table,
  type DrawEntry,
} from '@/lib/tournaments/draw';

/**
 * A CLUB TOURNAMENT'S DRAW (#580; decisions 54, 55, 57, 61): who meets whom.
 */
const entries = (n: number): DrawEntry[] =>
  Array.from({ length: n }, (_, i) => ({ id: `e${i + 1}`, strength: 100 - i }));
const first = () => 0;

describe('a knockout (54)', () => {
  it('pads the field to a power of two', () => {
    expect([2, 3, 4, 5, 8, 9].map(bracketSize)).toEqual([2, 4, 4, 8, 8, 16]);
  });

  it('seeds the strongest apart and gives them the byes', () => {
    const seeded = seedEntries(entries(6), first);
    // Eight places, two byes: seeds 1 and 2 get them.
    const specs = knockout(seeded.map((e) => e.id));
    const round1 = specs.filter((s) => s.round === 1);
    expect(round1).toHaveLength(4);
    const byes = round1.filter((s) => s.entryB === null).map((s) => s.entryA);
    expect(byes.sort()).toEqual(['e1', 'e2']);
    // Seeds 1 and 2 are in opposite halves: they can only meet in the final.
    const half = (id: string) =>
      round1.findIndex((s) => s.entryA === id || s.entryB === id) < 2 ? 0 : 1;
    expect(half('e1')).not.toBe(half('e2'));
  });

  it('draws the unseeded at random, the seeds in order', () => {
    const random = jestRandom([0.9, 0.1, 0.5, 0.3]);
    const seeded = seedEntries(entries(8), random);
    expect(seeded.slice(0, 2).map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(
      seeded
        .slice(2)
        .map((e) => e.id)
        .sort(),
    ).toEqual(['e3', 'e4', 'e5', 'e6', 'e7', 'e8']);
  });

  it('every match points at the one its winner goes to; the final points nowhere', () => {
    const specs = knockout(entries(8).map((e) => e.id));
    expect(specs.map((s) => `${s.round}:${s.slot}`)).toEqual([
      '1:0',
      '1:1',
      '1:2',
      '1:3',
      '2:0',
      '2:1',
      '3:0',
    ]);
    expect(specs.find((s) => s.key === 'ko:1:3')!.next).toEqual({ key: 'ko:2:1', side: 1 });
    expect(specs.find((s) => s.key === 'ko:3:0')!.next).toBeNull();
  });

  it('with a third-place match (61), the semi-final losers go to it', () => {
    const specs = knockout(
      entries(4).map((e) => e.id),
      { thirdPlace: true },
    );
    const third = specs.find((s) => s.stage === 'THIRD_PLACE')!;
    expect(third).toBeDefined();
    const semis = specs.filter((s) => s.stage === 'KNOCKOUT' && s.round === 1);
    expect(semis.map((s) => s.loserNext)).toEqual([
      { key: third.key, side: 0 },
      { key: third.key, side: 1 },
    ]);
    // A two-entry draw has no semi-finals, and so no match for third.
    expect(knockout(['a', 'b'], { thirdPlace: true }).some((s) => s.stage === 'THIRD_PLACE')).toBe(
      false,
    );
  });
});

describe('groups (55)', () => {
  it('spreads entries over the groups by level, in a snake', () => {
    expect(snakeGroups(entries(8), 2)).toEqual([
      ['e1', 'e4', 'e5', 'e8'],
      ['e2', 'e3', 'e6', 'e7'],
    ]);
  });

  it('everyone in a group plays everyone in it once, and nobody else', () => {
    const specs = groupMatches([
      ['a', 'b', 'c', 'd'],
      ['e', 'f', 'g'],
    ]);
    const pairs = (g: number) =>
      specs
        .filter((s) => s.groupNo === g)
        .map((s) => [s.entryA, s.entryB].sort().join('-'))
        .sort();
    expect(pairs(1)).toEqual(['a-b', 'a-c', 'a-d', 'b-c', 'b-d', 'c-d']);
    // Three in a group: three matches, each sits one round out.
    expect(pairs(2)).toEqual(['e-f', 'e-g', 'f-g']);
  });

  it('group winners are seeded first; no group’s two meet in the first round', () => {
    const order = qualifiersInSeedOrder(
      [
        ['A1', 'A2', 'A3'],
        ['B1', 'B2', 'B3'],
      ],
      2,
    );
    expect(order).toEqual(['A1', 'B1', 'A2', 'B2']);
    const round1 = knockout(order).filter((s) => s.round === 1);
    expect(round1.map((s) => [s.entryA, s.entryB])).toEqual([
      ['A1', 'B2'],
      ['B1', 'A2'],
    ]);
  });
});

describe('a table (57)', () => {
  it('a win 3, a draw 1, a loss 0', () => {
    const rows = table(
      ['a', 'b', 'c'],
      [
        { entryA: 'a', entryB: 'b', winnerSide: 0, score: [[2, 1]] },
        { entryA: 'b', entryB: 'c', winnerSide: null, score: [[1, 1]] },
        { entryA: 'c', entryB: 'a', winnerSide: 1, score: [[0, 3]] },
      ],
    );
    expect(rows.map((r) => [r.entryId, r.points])).toEqual([
      ['a', 6],
      ['b', 1],
      ['c', 1],
    ]);
  });

  it('level on points: head-to-head, then sets difference, then games', () => {
    const rows = table(
      ['a', 'b', 'c', 'd'],
      [
        // b beat a; both beat c and d by different margins.
        {
          entryA: 'a',
          entryB: 'b',
          winnerSide: 1,
          score: [
            [4, 6],
            [4, 6],
          ],
        },
        {
          entryA: 'a',
          entryB: 'c',
          winnerSide: 0,
          score: [
            [6, 0],
            [6, 0],
          ],
        },
        {
          entryA: 'b',
          entryB: 'd',
          winnerSide: 0,
          score: [
            [6, 4],
            [6, 4],
          ],
        },
      ],
    );
    // a and b both on 3: b won between them.
    expect(rows.slice(0, 2).map((r) => r.entryId)).toEqual(['b', 'a']);
  });

  it('a walkover is a win and a loss, and nothing in the differences', () => {
    const [x] = table(
      ['a', 'b'],
      [{ entryA: 'a', entryB: 'b', winnerSide: 0, score: null, walkover: true }],
    );
    expect(x).toMatchObject({ entryId: 'a', points: 3, won: 1, setsDiff: 0, gamesDiff: 0 });
  });
});

function jestRandom(values: number[]) {
  let i = 0;
  return () => values[i++ % values.length]!;
}
