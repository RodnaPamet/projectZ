import { drawAllowed, InvalidScoreError, scoreFormatFor, winnerOf } from '@/lib/ranking/score';

/** What a reported score must look like, per sport (#575, decision 46). */
describe('scores', () => {
  it.each([
    ['TENNIS', 'PERIODS'],
    ['PADEL', 'PERIODS'],
    ['TABLE_TENNIS', 'PERIODS'],
    ['SQUASH', 'PERIODS'],
    ['VOLLEYBALL', 'PERIODS'],
    ['FOOTBALL', 'TOTAL'],
    ['BASKETBALL', 'TOTAL'],
    ['CHESS', 'TOTAL'],
    ['ESPORTS', 'TOTAL'],
    ['KARTING', 'ORDER'],
    ['RUNNING', 'NONE'],
  ] as const)('%s is scored as %s', (sport, format) => {
    expect(scoreFormatFor(sport)).toBe(format);
  });

  it('sets and games: the side that won more sets', () => {
    expect(
      winnerOf('TENNIS', [
        [6, 4],
        [3, 6],
        [7, 5],
      ]),
    ).toBe(0);
    expect(
      winnerOf('PADEL', [
        [4, 6],
        [2, 6],
      ]),
    ).toBe(1);
    expect(
      winnerOf('TABLE_TENNIS', [
        [11, 9],
        [8, 11],
        [11, 7],
        [11, 5],
      ]),
    ).toBe(0);
  });

  it.each([
    ['a level set', [[6, 6]]],
    [
      'no winner in sets',
      [
        [6, 4],
        [4, 6],
      ],
    ],
    [
      'six sets',
      [
        [6, 0],
        [6, 0],
        [6, 0],
        [6, 0],
        [6, 0],
        [6, 0],
      ],
    ],
    ['a negative', [[6, -1]]],
    ['a fraction', [[6.5, 4]]],
    ['three numbers', [[6, 4, 2]]],
    ['a hundred games', [[100, 4]]],
    ['nothing', []],
    ['not a list', '6:4'],
  ])('refuses %s', (_label, score) => {
    expect(() => winnerOf('TENNIS', score)).toThrow(InvalidScoreError);
  });

  it('goals: one pair, and a draw is a result', () => {
    expect(winnerOf('FOOTBALL', [[3, 2]])).toBe(0);
    expect(winnerOf('FOOTBALL', [[1, 1]])).toBeNull();
    expect(drawAllowed('FOOTBALL')).toBe(true);
    expect(() =>
      winnerOf('FOOTBALL', [
        [1, 0],
        [2, 0],
      ]),
    ).toThrow(InvalidScoreError);
  });

  it('basketball has no draws', () => {
    expect(winnerOf('BASKETBALL', [[88, 79]])).toBe(0);
    expect(drawAllowed('BASKETBALL')).toBe(false);
    expect(() => winnerOf('BASKETBALL', [[80, 80]])).toThrow(InvalidScoreError);
  });

  it('karting and running have no score to report', () => {
    expect(() => winnerOf('KARTING', [[1, 0]])).toThrow(InvalidScoreError);
    expect(() => winnerOf('RUNNING', [[1, 0]])).toThrow(InvalidScoreError);
  });
});
