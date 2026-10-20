import { area, OUTLINE_MAX_POINTS, parseOutline } from '@/lib/venues/plan';

/** The plan's shapes (#623): anything that is not a sane polygon stays off it. */
describe('parseOutline', () => {
  const court: unknown = [
    [0, 0],
    [10, 0],
    [10, 20],
    [0, 20],
  ];

  it('reads a court-sized rectangle, rounded to centimetres', () => {
    expect(parseOutline(court)).toEqual(court);
    expect(
      parseOutline([
        [0.123, 0],
        [10, 0.456],
        [10, 20],
      ]),
    ).toEqual([
      [0.12, 0],
      [10, 0.46],
      [10, 20],
    ]);
  });

  it.each([
    ['not an array', { x: 1 }],
    [
      'two points',
      [
        [0, 0],
        [1, 1],
      ],
    ],
    ['too many points', Array.from({ length: OUTLINE_MAX_POINTS + 1 }, (_, i) => [i, i % 2])],
    ['a point that is not a pair', [[0, 0], [1], [1, 1]]],
    [
      'a string coordinate',
      [
        [0, 0],
        ['1', 0],
        [1, 1],
      ],
    ],
    [
      'an infinite coordinate',
      [
        [0, 0],
        [Infinity, 0],
        [1, 1],
      ],
    ],
    [
      'a point two kilometres away',
      [
        [0, 0],
        [2000, 0],
        [0, 1],
      ],
    ],
    [
      'points on one line',
      [
        [0, 0],
        [1, 1],
        [2, 2],
      ],
    ],
  ])('refuses %s', (_, raw) => {
    expect(parseOutline(raw)).toBeNull();
  });

  it('measures the area', () => {
    expect(area(court as [number, number][])).toBe(200);
  });
});
