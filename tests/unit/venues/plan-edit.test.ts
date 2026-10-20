import type { PlanPoint } from '@/lib/venues/plan';
import {
  angleTowards,
  editable,
  handlesOf,
  MIN_SIDE_M,
  moved,
  outlineOf,
  placed,
  resized,
  sameOutline,
  standardSize,
  stretched,
  turned,
} from '@/lib/venues/plan-edit';
import { courtFrame } from '@/lib/venues/plan-geometry';

/** The club's plan editor (#626), as numbers. */

const COURT: PlanPoint[] = [
  [0, 0],
  [20, 0],
  [20, 10],
  [0, 10],
];

const deg = (r: number) => (r * 180) / Math.PI;

describe('editable and outlineOf', () => {
  it('give back the outline they were given, to the centimetre', () => {
    expect(sameOutline(outlineOf(editable(COURT)), COURT)).toBe(true);
    const odd: PlanPoint[] = [
      [1.23, -4.56],
      [19.9, 0.4],
      [18.7, 11.01],
      [0.2, 9.5],
      [-1, 4],
    ];
    expect(sameOutline(outlineOf(editable(odd)), odd)).toBe(true);
  });

  it('keeps an odd shape through a move, a turn and a stretch', () => {
    const odd: PlanPoint[] = [
      [0, 0],
      [20, 0],
      [20, 10],
      [10, 12],
      [0, 10],
    ];
    const edited = resized(turned(moved(editable(odd), 5, 5), Math.PI / 2), 24, 12);
    const back = editable(outlineOf(edited));
    expect(back.shape.length).toBe(5);
    back.shape.forEach((p, i) => {
      expect(p[0]).toBeCloseTo(editable(odd).shape[i]![0], 2);
      expect(p[1]).toBeCloseTo(editable(odd).shape[i]![1], 2);
    });
  });
});

describe('moving, turning, stretching', () => {
  const court = editable(COURT);

  it('moves by metres east and north', () => {
    const frame = courtFrame(outlineOf(moved(court, 3, -2)));
    expect(frame.cx).toBeCloseTo(13);
    expect(frame.cy).toBeCloseTo(3);
  });

  it('turns about the centre, snapping near 45° steps', () => {
    expect(deg(turned(court, (30 * Math.PI) / 180).frame.angle)).toBeCloseTo(30);
    expect(deg(turned(court, (88.5 * Math.PI) / 180).frame.angle)).toBeCloseTo(90);
    expect(deg(turned(court, (46 * Math.PI) / 180).frame.angle)).toBeCloseTo(45);
    const frame = courtFrame(outlineOf(turned(court, Math.PI / 2)));
    expect([frame.cx, frame.cy, frame.length, frame.width].map((n) => Math.round(n))).toEqual([
      10, 5, 20, 10,
    ]);
  });

  it('stretches one end while the other stays put', () => {
    // The front end (+x) dragged to x = 26: the back stays at x = 0.
    const longer = stretched(court, 'front', [26, 3]);
    expect(longer.frame.length).toBeCloseTo(26);
    const xs = outlineOf(longer).map((p) => p[0]);
    expect(Math.min(...xs)).toBeCloseTo(0);
    expect(Math.max(...xs)).toBeCloseTo(26);

    // The right side (-y) dragged down to y = -4: the left stays at y = 10.
    const wider = stretched(court, 'right', [7, -4]);
    const ys = outlineOf(wider).map((p) => p[1]);
    expect(Math.max(...ys)).toBeCloseTo(10);
    expect(Math.min(...ys)).toBeCloseTo(-4);
  });

  it('never stretches a side past the opposite one', () => {
    const flat = stretched(court, 'front', [-30, 0]);
    expect(flat.frame.length).toBe(MIN_SIDE_M);
    expect(resized(court, 0, 500).frame).toMatchObject({ length: MIN_SIDE_M, width: 150 });
  });
});

describe('the handles', () => {
  it('sit on each side’s middle, and the turn handle beyond the left side', () => {
    const h = handlesOf(editable(COURT), 3);
    expect(h.front).toEqual([20, 5]);
    expect(h.back).toEqual([0, 5]);
    expect(h.left[1]).toBeCloseTo(10);
    expect(h.right[1]).toBeCloseTo(0);
    expect(h.turn[0]).toBeCloseTo(10);
    expect(h.turn[1]).toBeCloseTo(13);
  });

  it('turn the court to face the handle', () => {
    const court = editable(COURT);
    // The handle dragged due east of the centre: the length now runs north-south.
    expect(deg(angleTowards(court, [30, 5]))).toBeCloseTo(-90);
    expect(deg(angleTowards(court, [10, 30]))).toBeCloseTo(0);
  });
});

describe('placing a new court', () => {
  it('is the sport’s standard size, on the venue’s point when the plan is empty', () => {
    expect(standardSize('TENNIS')).toEqual({ length: 23.77, width: 10.97 });
    expect(standardSize('KARTING')).toEqual({ length: 20, width: 10 });
    const first = placed('PADEL', []);
    expect(outlineOf(first)).toEqual([
      [-10, -5],
      [10, -5],
      [10, 5],
      [-10, 5],
    ]);
  });

  it('goes two metres east of everything already there', () => {
    const next = outlineOf(placed('PADEL', [COURT]));
    expect(Math.min(...next.map((p) => p[0]))).toBeCloseTo(22);
    expect(Math.min(...next.map((p) => p[1]))).toBeCloseTo(0);
  });
});
