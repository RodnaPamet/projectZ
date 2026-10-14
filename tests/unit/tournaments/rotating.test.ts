import { americano, mexicanoRound, pointsTable, pointsWinner } from '@/lib/tournaments/rotating';

/**
 * AMERICANO AND MEXICANO (#590; decisions 56, 60): who partners whom, who
 * sits out, and the points table.
 */
const players = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const seq = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

describe('Americano (60)', () => {
  it('eight players, seven rounds: two matches a round, and nobody partners anybody twice', () => {
    const matches = americano(players(8), 7, seq([0.3, 0.7, 0.1, 0.9, 0.5]));
    expect(matches).toHaveLength(14);
    const partnerships = matches.flatMap((m) => [m.a, m.b]).map((p) => [...p].sort().join('|'));
    // 28 pairs exist among eight players; seven rounds use each exactly once.
    expect(new Set(partnerships).size).toBe(28);
    for (let r = 1; r <= 7; r++) {
      const inRound = matches.filter((m) => m.round === r).flatMap((m) => [...m.a, ...m.b]);
      expect(new Set(inRound).size).toBe(8);
    }
  });

  it('five players: one match a round, and the rounds off go round', () => {
    const matches = americano(players(5), 5, seq([0.2, 0.8, 0.4, 0.6]));
    const playedBy = (p: string) => matches.filter((m) => [...m.a, ...m.b].includes(p)).length;
    // Five rounds, one sitting out each: everyone sits out once, plays four.
    expect(players(5).map(playedBy)).toEqual([4, 4, 4, 4, 4]);
  });
});

describe('Mexicano (60)', () => {
  it('fours down the table: 1st and 4th against 2nd and 3rd', () => {
    expect(mexicanoRound(players(8), 2, new Map())).toEqual([
      { round: 2, slot: 0, a: ['p1', 'p4'], b: ['p2', 'p3'] },
      { round: 2, slot: 1, a: ['p5', 'p8'], b: ['p6', 'p7'] },
    ]);
  });

  it('a player too many sits out: the fewest rounds off, the lowest-ranked of them', () => {
    const round = mexicanoRound(players(5), 1, new Map([['p5', 1]]));
    // p5 has sat out once; p4 is the lowest-ranked of the others.
    expect(round[0]).toEqual({ round: 1, slot: 0, a: ['p1', 'p5'], b: ['p2', 'p3'] });
  });
});

describe('the points table (56)', () => {
  it('points won, then the difference, then matches won', () => {
    const rows = pointsTable(players(4), [
      { a: ['p1', 'p2'], b: ['p3', 'p4'], score: [15, 9], winnerSide: 0 },
      { a: ['p1', 'p3'], b: ['p2', 'p4'], score: [10, 14], winnerSide: 1 },
    ]);
    expect(rows.map((r) => [r.entryId, r.points, r.diff])).toEqual([
      ['p2', 29, 10],
      ['p1', 25, 2],
      ['p4', 23, -2],
      ['p3', 19, -10],
    ]);
  });

  it('a match adds up to its points: a draw is a result, a short total is not', () => {
    expect(pointsWinner([[13, 11]], 24)).toBe(0);
    expect(pointsWinner([[12, 12]], 24)).toBeNull();
    expect(() => pointsWinner([[13, 10]], 24)).toThrow('played to 24 points');
    expect(() =>
      pointsWinner(
        [
          [6, 4],
          [6, 3],
        ],
        24,
      ),
    ).toThrow('one pair');
  });
});
