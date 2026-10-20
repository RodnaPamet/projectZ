import type { PlanPoint } from './plan';

/**
 * The venue plan's drawing (#625), as plain numbers: nothing here touches a
 * canvas, so all of it is tested without one. Every shape is in METRES in the
 * venue's frame (x east, y north, `plan.ts`).
 */

/** Where a court lies: its centre, the direction of its long side, its size. */
export interface CourtFrame {
  cx: number;
  cy: number;
  /** Radians from east to the court's long side. */
  angle: number;
  length: number;
  width: number;
}

/**
 * The smallest rectangle around a court's outline, its long side as the
 * length. One side of that rectangle lies along an edge of the convex hull, so
 * every hull edge is tried: a court has a handful of points.
 */
export function courtFrame(points: PlanPoint[]): CourtFrame {
  const hull = convexHull(points);
  let best: CourtFrame | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i]!;
    const [x2, y2] = hull[(i + 1) % hull.length]!;
    const theta = Math.atan2(y2 - y1, x2 - x1);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * cos + y * sin;
      const v = -x * sin + y * cos;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area >= bestArea - 1e-9) continue;
    bestArea = area;
    const u = (minU + maxU) / 2;
    const v = (minV + maxV) / 2;
    const along = maxU - minU >= maxV - minV;
    best = {
      cx: u * cos - v * sin,
      cy: u * sin + v * cos,
      angle: normalAngle(along ? theta : theta + Math.PI / 2),
      length: along ? maxU - minU : maxV - minV,
      width: along ? maxV - minV : maxU - minU,
    };
  }
  return best ?? { cx: 0, cy: 0, angle: 0, length: 0, width: 0 };
}

/** An angle folded into [0, π): a court's long side has no front and back. */
function normalAngle(a: number) {
  const r = a % Math.PI;
  return r < 0 ? r + Math.PI : r;
}

/** Andrew's monotone chain, counter-clockwise, without collinear points. */
function convexHull(points: PlanPoint[]): PlanPoint[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: PlanPoint, a: PlanPoint, b: PlanPoint) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: PlanPoint[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: PlanPoint[] = [];
  for (const p of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0)
      upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * One stroke of a court's markings, in metres from the court's centre: x along
 * its length, y across. `net` and `wall` are drawn heavier than a line.
 */
export interface Mark {
  points: PlanPoint[];
  style: 'line' | 'net' | 'wall';
}

/** A sport's markings at its standard size. */
export interface Markings {
  length: number;
  width: number;
  marks: Mark[];
}

const line = (points: PlanPoint[], style: Mark['style'] = 'line'): Mark => ({ points, style });

/** The four sides of a `length` × `width` rectangle around the centre. */
function box(length: number, width: number, style: Mark['style'] = 'line'): Mark {
  const l = length / 2;
  const w = width / 2;
  return line(
    [
      [-l, -w],
      [l, -w],
      [l, w],
      [-l, w],
      [-l, -w],
    ],
    style,
  );
}

/** An arc around `at`, `from` to `to` radians, as a polyline. */
function arc(at: PlanPoint, r: number, from: number, to: number, steps = 24): Mark {
  const points: PlanPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    points.push([at[0] + r * Math.cos(a), at[1] + r * Math.sin(a)]);
  }
  return line(points);
}

/** Both ends of a court, mirrored: what a sport draws at one end, at the other too. */
function bothEnds(make: (end: 1 | -1) => Mark[]): Mark[] {
  return [...make(1), ...make(-1)];
}

/** The net across the middle, `overhang` past each side. */
const net = (width: number, overhang = 0) =>
  line(
    [
      [0, -width / 2 - overhang],
      [0, width / 2 + overhang],
    ],
    'net',
  );

/** Handball's and futsal's goal area: two quarter circles from the posts, joined. */
function goalArea(half: number, r: number, post: number): Mark[] {
  return bothEnds((end) => {
    const x = end * half;
    // At the right end the arcs open toward the middle (π/2..π, π..3π/2);
    // at the left end they mirror (0..π/2, -π/2..0).
    const [a1, a2, b1, b2] =
      end === 1
        ? [Math.PI / 2, Math.PI, Math.PI, (3 * Math.PI) / 2]
        : [0, Math.PI / 2, -Math.PI / 2, 0];
    return [
      arc([x, post], r, a1, a2, 12),
      arc([x, -post], r, b1, b2, 12),
      line([
        [x - end * r, -post],
        [x - end * r, post],
      ]),
    ];
  });
}

/**
 * Each sport's lines at their standard sizes (the federations' courts). A sport
 * without a drawing here is drawn as its outline alone.
 */
export function markingsFor(sport: string): Markings | null {
  switch (sport) {
    case 'TENNIS': {
      const [l, w, singles, service] = [23.77, 10.97, 8.23, 6.4];
      return {
        length: l,
        width: w,
        marks: [
          box(l, w),
          ...bothEnds((s) => [
            line([
              [-l / 2, (s * singles) / 2],
              [l / 2, (s * singles) / 2],
            ]),
            line([
              [s * service, -singles / 2],
              [s * service, singles / 2],
            ]),
          ]),
          line([
            [-service, 0],
            [service, 0],
          ]),
          net(w, 0.914),
        ],
      };
    }
    case 'PADEL': {
      const [l, w, service, glass] = [20, 10, 6.95, 4];
      return {
        length: l,
        width: w,
        marks: [
          box(l, w),
          ...bothEnds((s) => [
            line([
              [s * service, -w / 2],
              [s * service, w / 2],
            ]),
            // The glass: the back wall, and four metres of each side wall.
            line(
              [
                [s * (l / 2 - glass), -w / 2],
                [(s * l) / 2, -w / 2],
                [(s * l) / 2, w / 2],
                [s * (l / 2 - glass), w / 2],
              ],
              'wall',
            ),
          ]),
          line([
            [-service, 0],
            [service, 0],
          ]),
          net(w),
        ],
      };
    }
    case 'BADMINTON': {
      const [l, w, singles, short, long] = [13.4, 6.1, 5.18, 1.98, 0.76];
      return {
        length: l,
        width: w,
        marks: [
          box(l, w),
          ...bothEnds((s) => [
            line([
              [-l / 2, (s * singles) / 2],
              [l / 2, (s * singles) / 2],
            ]),
            line([
              [s * short, -w / 2],
              [s * short, w / 2],
            ]),
            line([
              [s * (l / 2 - long), -w / 2],
              [s * (l / 2 - long), w / 2],
            ]),
            line([
              [s * short, 0],
              [(s * l) / 2, 0],
            ]),
          ]),
          net(w),
        ],
      };
    }
    case 'PICKLEBALL': {
      const [l, w, kitchen] = [13.41, 6.1, 2.13];
      return {
        length: l,
        width: w,
        marks: [
          box(l, w),
          ...bothEnds((s) => [
            line([
              [s * kitchen, -w / 2],
              [s * kitchen, w / 2],
            ]),
            line([
              [s * kitchen, 0],
              [(s * l) / 2, 0],
            ]),
          ]),
          net(w),
        ],
      };
    }
    case 'BEACH_TENNIS':
      return { length: 16, width: 8, marks: [box(16, 8), net(8)] };
    case 'BEACH_VOLLEYBALL':
      return { length: 16, width: 8, marks: [box(16, 8), net(8, 0.5)] };
    case 'VOLLEYBALL': {
      const [l, w, attack] = [18, 9, 3];
      return {
        length: l,
        width: w,
        marks: [
          box(l, w),
          ...bothEnds((s) => [
            line([
              [s * attack, -w / 2],
              [s * attack, w / 2],
            ]),
          ]),
          net(w, 0.5),
        ],
      };
    }
    case 'TABLE_TENNIS': {
      const [l, w] = [2.74, 1.525];
      return {
        length: l,
        width: w,
        marks: [
          box(l, w),
          line([
            [-l / 2, 0],
            [l / 2, 0],
          ]),
          net(w, 0.1525),
        ],
      };
    }
    case 'SQUASH': {
      // The front wall at -x; the short line 5.44 m from it, the half-court
      // line and the service boxes behind it.
      const [l, w, short, boxSide] = [9.75, 6.4, 5.44, 1.6];
      const sx = -l / 2 + short;
      return {
        length: l,
        width: w,
        marks: [
          box(l, w),
          line(
            [
              [-l / 2, -w / 2],
              [-l / 2, w / 2],
            ],
            'wall',
          ),
          line([
            [sx, -w / 2],
            [sx, w / 2],
          ]),
          line([
            [sx, 0],
            [l / 2, 0],
          ]),
          ...bothEnds((s) => [
            line([
              [sx, s * (w / 2 - boxSide)],
              [sx + boxSide, s * (w / 2 - boxSide)],
              [sx + boxSide, (s * w) / 2],
            ]),
          ]),
        ],
      };
    }
    case 'BASKETBALL': {
      const [l, w, key, keyWidth, basket, three, corner] = [28, 15, 5.8, 4.9, 1.575, 6.75, 6.6];
      const sweep = Math.asin(corner / three);
      return {
        length: l,
        width: w,
        marks: [
          box(l, w),
          line([
            [0, -w / 2],
            [0, w / 2],
          ]),
          arc([0, 0], 1.8, 0, 2 * Math.PI, 32),
          ...bothEnds((s) => {
            const hoop = s * (l / 2 - basket);
            const reach = Math.cos(sweep) * three;
            const [from, to] = s === 1 ? [Math.PI - sweep, Math.PI + sweep] : [-sweep, sweep];
            return [
              line([
                [(s * l) / 2, -keyWidth / 2],
                [s * (l / 2 - key), -keyWidth / 2],
                [s * (l / 2 - key), keyWidth / 2],
                [(s * l) / 2, keyWidth / 2],
              ]),
              arc([hoop, 0], three, from, to, 32),
              ...[1, -1].map((side) =>
                line([
                  [(s * l) / 2, side * corner],
                  [hoop - s * reach, side * corner],
                ]),
              ),
            ];
          }),
        ],
      };
    }
    case 'HANDBALL':
      return {
        length: 40,
        width: 20,
        marks: [
          box(40, 20),
          line([
            [0, -10],
            [0, 10],
          ]),
          ...goalArea(20, 6, 1.5),
        ],
      };
    case 'FOOTBALL5':
      return {
        length: 40,
        width: 20,
        marks: [
          box(40, 20),
          line([
            [0, -10],
            [0, 10],
          ]),
          arc([0, 0], 3, 0, 2 * Math.PI, 32),
          ...goalArea(20, 6, 1.5),
        ],
      };
    case 'FOOTBALL': {
      const [l, w, boxDepth, boxWidth, goalDepth, goalWidth, spot, r] = [
        105, 68, 16.5, 40.32, 5.5, 18.32, 11, 9.15,
      ];
      // The penalty arc is the part of the spot's circle outside the box.
      const sweep = Math.acos((boxDepth - spot) / r);
      return {
        length: l,
        width: w,
        marks: [
          box(l, w),
          line([
            [0, -w / 2],
            [0, w / 2],
          ]),
          arc([0, 0], r, 0, 2 * Math.PI, 48),
          ...bothEnds((s) => {
            const x = (s * l) / 2;
            const [from, to] = s === 1 ? [Math.PI - sweep, Math.PI + sweep] : [-sweep, sweep];
            return [
              line([
                [x, -boxWidth / 2],
                [x - s * boxDepth, -boxWidth / 2],
                [x - s * boxDepth, boxWidth / 2],
                [x, boxWidth / 2],
              ]),
              line([
                [x, -goalWidth / 2],
                [x - s * goalDepth, -goalWidth / 2],
                [x - s * goalDepth, goalWidth / 2],
                [x, goalWidth / 2],
              ]),
              arc([s * (l / 2 - spot), 0], r, from, to, 16),
            ];
          }),
        ],
      };
    }
    default:
      return null;
  }
}

/**
 * A sport's markings placed on a court: scaled down to fit when the outline is
 * smaller than the standard court, never up (an outline larger than the court
 * is the court with its run-off around it), centred and turned with it.
 */
export function placeMarkings(m: Markings, frame: CourtFrame): Mark[] {
  if (frame.length <= 0 || frame.width <= 0) return [];
  const s = Math.min(1, frame.length / m.length, frame.width / m.width);
  const cos = Math.cos(frame.angle);
  const sin = Math.sin(frame.angle);
  return m.marks.map((mark) => ({
    style: mark.style,
    points: mark.points.map(([u, v]) => [
      frame.cx + s * (u * cos - v * sin),
      frame.cy + s * (u * sin + v * cos),
    ]),
  }));
}

/** The box around every shape: min x, min y, max x, max y. */
export function planBounds(shapes: PlanPoint[][]): [number, number, number, number] {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const shape of shapes) {
    for (const [x, y] of shape) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : [0, 0, 0, 0];
}

/**
 * Metres to CSS pixels, the whole plan fitted inside `width` × `height` less
 * `pad` on every side, north up. `scale` is pixels per metre.
 */
export interface Fit {
  scale: number;
  /** Screen x of the plan's x = 0. */
  ox: number;
  /** Screen y of the plan's y = 0 (screen y grows down, the plan's up). */
  oy: number;
}

export function fitPlan(
  bounds: [number, number, number, number],
  width: number,
  height: number,
  pad: number,
): Fit {
  const [minX, minY, maxX, maxY] = bounds;
  const w = Math.max(maxX - minX, 1);
  const h = Math.max(maxY - minY, 1);
  const scale = Math.max(Math.min((width - 2 * pad) / w, (height - 2 * pad) / h), 0.01);
  return {
    scale,
    ox: pad + (width - 2 * pad - w * scale) / 2 - minX * scale,
    oy: pad + (height - 2 * pad - h * scale) / 2 + maxY * scale,
  };
}

/**
 * The canvas's height for a plan `width` pixels wide: the plan's own
 * proportions, within `min`..`max`.
 */
export function planHeight(
  bounds: [number, number, number, number],
  width: number,
  min = 200,
  max = 420,
): number {
  const [minX, minY, maxX, maxY] = bounds;
  const ratio = Math.max(maxY - minY, 1) / Math.max(maxX - minX, 1);
  return Math.round(Math.min(max, Math.max(min, width * ratio)));
}

/**
 * The pan and zoom on top of the fit: a screen point is `k · fit(p) + (tx, ty)`.
 * `k` is 1 for the whole plan and up to `MAX_ZOOM` closer.
 */
export interface View {
  k: number;
  tx: number;
  ty: number;
}

export const MAX_ZOOM = 8;

/** A plan point on the screen. */
export function toScreen(p: PlanPoint, fit: Fit, view: View): PlanPoint {
  return [
    view.k * (fit.ox + p[0] * fit.scale) + view.tx,
    view.k * (fit.oy - p[1] * fit.scale) + view.ty,
  ];
}

/** A screen point on the plan. */
export function toPlan(s: PlanPoint, fit: Fit, view: View): PlanPoint {
  const fx = (s[0] - view.tx) / view.k;
  const fy = (s[1] - view.ty) / view.k;
  return [(fx - fit.ox) / fit.scale, (fit.oy - fy) / fit.scale];
}

/**
 * Zoom by `factor` about the screen point `at`, which stays where it is; then
 * keep the plan on the canvas (`clampView`).
 */
export function zoomAt(
  view: View,
  factor: number,
  at: PlanPoint,
  width: number,
  height: number,
): View {
  const k = Math.min(MAX_ZOOM, Math.max(1, view.k * factor));
  const ratio = k / view.k;
  return clampView(
    { k, tx: at[0] - (at[0] - view.tx) * ratio, ty: at[1] - (at[1] - view.ty) * ratio },
    width,
    height,
  );
}

/**
 * Keep the zoomed plan covering the canvas: at k the fitted canvas is k times
 * its size, so it may move by at most (k - 1) of it. At k = 1 nothing moves.
 */
export function clampView(view: View, width: number, height: number): View {
  return {
    k: view.k,
    tx: Math.min(0, Math.max(width * (1 - view.k), view.tx)),
    ty: Math.min(0, Math.max(height * (1 - view.k), view.ty)),
  };
}

/** Whether `p` lies inside the polygon (even-odd ray casting). */
export function pointInPolygon(p: PlanPoint, polygon: PlanPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
