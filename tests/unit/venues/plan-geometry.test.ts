import type { PlanPoint } from '@/lib/venues/plan';
import {
  clampView,
  courtFrame,
  fitPlan,
  markingsFor,
  MAX_ZOOM,
  placeMarkings,
  planBounds,
  planHeight,
  pointInPolygon,
  toPlan,
  toScreen,
  zoomAt,
} from '@/lib/venues/plan-geometry';

/** The venue plan's drawing (#625), as numbers. */

/** A `length` × `width` rectangle around (cx, cy), its long side `deg` from east. */
function court(cx: number, cy: number, length: number, width: number, deg: number): PlanPoint[] {
  const a = (deg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(a), Math.sin(a)];
  return [
    [-length / 2, -width / 2],
    [length / 2, -width / 2],
    [length / 2, width / 2],
    [-length / 2, width / 2],
  ].map(([u, v]) => [cx + u! * cos - v! * sin, cy + u! * sin + v! * cos]);
}

describe('courtFrame', () => {
  it.each([0, 30, 90, 135])('finds a %i° court’s centre, direction and size', (deg) => {
    const frame = courtFrame(court(12, -7, 20, 10, deg));
    expect(frame.cx).toBeCloseTo(12);
    expect(frame.cy).toBeCloseTo(-7);
    expect(frame.length).toBeCloseTo(20);
    expect(frame.width).toBeCloseTo(10);
    // A long side has no front and back: 0..180°.
    expect((frame.angle * 180) / Math.PI).toBeCloseTo(deg % 180);
  });

  it('takes the long side as the length whichever way the points run', () => {
    const tall = courtFrame([
      [0, 0],
      [10, 0],
      [10, 20],
      [0, 20],
    ]);
    expect(tall.length).toBeCloseTo(20);
    expect(tall.width).toBeCloseTo(10);
    expect((tall.angle * 180) / Math.PI).toBeCloseTo(90);
  });

  it('ignores a dent: the box is around the hull', () => {
    const frame = courtFrame([
      [0, 0],
      [20, 0],
      [20, 10],
      [10, 5],
      [0, 10],
    ]);
    expect(frame.length).toBeCloseTo(20);
    expect(frame.width).toBeCloseTo(10);
  });
});

describe('markingsFor', () => {
  it.each([
    'TENNIS',
    'PADEL',
    'BADMINTON',
    'PICKLEBALL',
    'SQUASH',
    'BASKETBALL',
    'FOOTBALL',
    'FOOTBALL5',
    'HANDBALL',
    'VOLLEYBALL',
    'BEACH_VOLLEYBALL',
    'BEACH_TENNIS',
    'TABLE_TENNIS',
  ])('%s: lines inside its own court, and a net or a halfway line', (sport) => {
    const m = markingsFor(sport)!;
    expect(m.marks.length).toBeGreaterThan(1);
    for (const mark of m.marks) {
      for (const [x, y] of mark.points) {
        // A net may overhang the sidelines; nothing else leaves the court.
        const overhang = mark.style === 'net' ? 1 : 1e-9;
        expect(Math.abs(x)).toBeLessThanOrEqual(m.length / 2 + 1e-9);
        expect(Math.abs(y)).toBeLessThanOrEqual(m.width / 2 + overhang);
      }
    }
  });

  it('draws padel’s glass as walls', () => {
    expect(markingsFor('PADEL')!.marks.filter((m) => m.style === 'wall')).toHaveLength(2);
  });

  it.each(['KARTING', 'CHESS', 'RUNNING', 'SOMETHING_NEW'])(
    '%s: no lines, the outline alone',
    (s) => {
      expect(markingsFor(s)).toBeNull();
    },
  );
});

describe('placeMarkings', () => {
  const tennis = markingsFor('TENNIS')!;

  it('keeps the true size on a court with run-off around it, centred and turned', () => {
    const frame = courtFrame(court(100, 50, 36, 18, 90));
    const outer = placeMarkings(tennis, frame)[0]!;
    const ys = outer.points.map((p) => p[1]);
    const xs = outer.points.map((p) => p[0]);
    // Turned 90°: the 23.77 m length runs north.
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(23.77);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(10.97);
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(100);
    expect((Math.max(...ys) + Math.min(...ys)) / 2).toBeCloseTo(50);
  });

  it('shrinks the lines into a smaller outline, keeping their proportions', () => {
    const frame = courtFrame(court(0, 0, 11.885, 10, 0));
    const outer = placeMarkings(tennis, frame)[0]!;
    const xs = outer.points.map((p) => p[0]);
    const ys = outer.points.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(11.885);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(10.97 / 2);
  });
});

describe('the view', () => {
  const bounds = planBounds([court(0, 0, 20, 10, 0), court(22, 0, 20, 10, 0)]);

  it('fits the whole plan inside the padding, centred', () => {
    expect(bounds).toEqual([-10, -5, 32, 5]);
    const fit = fitPlan(bounds, 700, 200, 16);
    const [left, top] = toScreen([-10, 5], fit, { k: 1, tx: 0, ty: 0 });
    const [right, bottom] = toScreen([32, -5], fit, { k: 1, tx: 0, ty: 0 });
    expect(Math.min(left, top)).toBeGreaterThanOrEqual(16 - 1e-9);
    expect(right).toBeLessThanOrEqual(700 - 16 + 1e-9);
    expect(bottom).toBeLessThanOrEqual(200 - 16 + 1e-9);
    // Centred both ways, north up.
    expect(left + right).toBeCloseTo(700);
    expect(top + bottom).toBeCloseTo(200);
    expect(top).toBeLessThan(bottom);
  });

  it('maps the screen back onto the plan, zoomed and panned', () => {
    const fit = fitPlan(bounds, 700, 200, 16);
    const view = { k: 2.5, tx: -300, ty: -80 };
    const p: PlanPoint = [7.25, -3.5];
    const [x, y] = toPlan(toScreen(p, fit, view), fit, view);
    expect(x).toBeCloseTo(7.25);
    expect(y).toBeCloseTo(-3.5);
  });

  it('zooms about the point under the fingers, which stays put', () => {
    const fit = fitPlan(bounds, 700, 200, 16);
    const at: PlanPoint = [500, 120];
    const under = toPlan(at, fit, { k: 1, tx: 0, ty: 0 });
    const view = zoomAt({ k: 1, tx: 0, ty: 0 }, 2, at, 700, 200);
    expect(view.k).toBe(2);
    const [x, y] = toScreen(under, fit, view);
    expect(x).toBeCloseTo(500);
    expect(y).toBeCloseTo(120);
  });

  it('never zooms out past the whole plan, nor in past the limit', () => {
    expect(zoomAt({ k: 1, tx: 0, ty: 0 }, 0.5, [10, 10], 700, 200)).toEqual({ k: 1, tx: 0, ty: 0 });
    expect(zoomAt({ k: 6, tx: 0, ty: 0 }, 4, [0, 0], 700, 200).k).toBe(MAX_ZOOM);
  });

  it('keeps the zoomed plan covering the canvas', () => {
    expect(clampView({ k: 2, tx: 50, ty: -900 }, 700, 200)).toEqual({ k: 2, tx: 0, ty: -200 });
    expect(clampView({ k: 1, tx: -40, ty: 30 }, 700, 200)).toEqual({ k: 1, tx: 0, ty: 0 });
  });

  it('gives a wide plan the minimum height and a tall one the maximum', () => {
    expect(planHeight(bounds, 700)).toBe(200);
    expect(planHeight([0, 0, 10, 100], 700)).toBe(420);
    expect(planHeight([0, 0, 100, 50], 600)).toBe(300);
  });
});

describe('pointInPolygon', () => {
  const square = court(0, 0, 10, 10, 45);

  it('says inside or outside, turned courts too', () => {
    expect(pointInPolygon([0, 0], square)).toBe(true);
    expect(pointInPolygon([0, 6.9], square)).toBe(true);
    expect(pointInPolygon([5, 5], square)).toBe(false);
    expect(pointInPolygon([0, 7.2], square)).toBe(false);
  });
});
