import type { PlanPoint } from './plan';
import { courtFrame, markingsFor, type CourtFrame } from './plan-geometry';

/**
 * The club's plan editor (#626), as numbers: move, turn and stretch a court,
 * or place a new one. Nothing here touches a canvas.
 *
 * A court being edited is its frame (centre, direction, length, width) and its
 * shape within that frame, each point as a fraction of the length and the
 * width. Moving, turning and stretching change only the frame, so an outline
 * from OpenStreetMap that is not quite a rectangle keeps its shape.
 */

export interface EditedCourt {
  frame: CourtFrame;
  /** The outline in the frame: u along the length, v across, each -0.5..0.5. */
  shape: PlanPoint[];
}

/** The smallest and the largest a court may be stretched to, in metres. */
export const MIN_SIDE_M = 1;
export const MAX_SIDE_M = 150;

const clampSide = (m: number) => Math.min(MAX_SIDE_M, Math.max(MIN_SIDE_M, m));

export function editable(outline: PlanPoint[]): EditedCourt {
  const frame = courtFrame(outline);
  const [cos, sin] = [Math.cos(frame.angle), Math.sin(frame.angle)];
  const length = frame.length || 1;
  const width = frame.width || 1;
  return {
    frame,
    shape: outline.map(([x, y]) => {
      const [dx, dy] = [x - frame.cx, y - frame.cy];
      return [(dx * cos + dy * sin) / length, (-dx * sin + dy * cos) / width];
    }),
  };
}

/** The outline in the venue's frame, in centimetres as the server keeps it. */
export function outlineOf({ frame, shape }: EditedCourt): PlanPoint[] {
  const [cos, sin] = [Math.cos(frame.angle), Math.sin(frame.angle)];
  // `|| 0`: a -0 would round-trip to the database as "-0".
  const cm = (n: number) => Math.round(n * 100) / 100 || 0;
  return shape.map(([u, v]) => {
    const [a, b] = [u * frame.length, v * frame.width];
    return [cm(frame.cx + a * cos - b * sin), cm(frame.cy + a * sin + b * cos)];
  });
}

export function moved(c: EditedCourt, dx: number, dy: number): EditedCourt {
  return { ...c, frame: { ...c.frame, cx: c.frame.cx + dx, cy: c.frame.cy + dy } };
}

/** Turned to `angle` radians from east; within 2° of a multiple of 45° it snaps there. */
export function turned(c: EditedCourt, angle: number): EditedCourt {
  const step = Math.PI / 4;
  const nearest = Math.round(angle / step) * step;
  const a = Math.abs(angle - nearest) < (2 * Math.PI) / 180 ? nearest : angle;
  return { ...c, frame: { ...c.frame, angle: a } };
}

export function resized(c: EditedCourt, length: number, width: number): EditedCourt {
  return { ...c, frame: { ...c.frame, length: clampSide(length), width: clampSide(width) } };
}

/**
 * The four sides a court is stretched by: its two ends (`front` at +u, `back`
 * at -u) and its two long sides (`left` at +v, `right` at -v).
 */
export type Side = 'front' | 'back' | 'left' | 'right';

/** The court's axes: along its length, and across it. */
function axes(frame: CourtFrame) {
  const [cos, sin] = [Math.cos(frame.angle), Math.sin(frame.angle)];
  return { along: [cos, sin] as PlanPoint, across: [-sin, cos] as PlanPoint };
}

/** Stretch one side to the plan point `p`; the opposite side stays where it is. */
export function stretched(c: EditedCourt, side: Side, p: PlanPoint): EditedCourt {
  const { frame } = c;
  const { along, across } = axes(frame);
  const lengthwise = side === 'front' || side === 'back';
  const axis = lengthwise ? along : across;
  const half = (lengthwise ? frame.length : frame.width) / 2;
  const sign = side === 'front' || side === 'left' ? 1 : -1;
  // Where `p` lies along the axis, from the centre; the far side stays at -sign·half.
  const t = (p[0] - frame.cx) * axis[0] + (p[1] - frame.cy) * axis[1];
  const fixed = -sign * half;
  const size = clampSide(sign * (t - fixed));
  const middle = fixed + (sign * size) / 2;
  const next = {
    ...frame,
    cx: frame.cx + axis[0] * middle,
    cy: frame.cy + axis[1] * middle,
    ...(lengthwise ? { length: size } : { width: size }),
  };
  return { ...c, frame: next };
}

/** Where the handles sit, on the plan: each side's middle, and the turn handle. */
export function handlesOf(
  c: EditedCourt,
  /** How far beyond the left side the turn handle sits, in metres. */
  reach: number,
): Record<Side | 'turn', PlanPoint> {
  const { frame } = c;
  const { along, across } = axes(frame);
  const at = (u: number, v: number): PlanPoint => [
    frame.cx + along[0] * u + across[0] * v,
    frame.cy + along[1] * u + across[1] * v,
  ];
  const [l, w] = [frame.length / 2, frame.width / 2];
  return {
    front: at(l, 0),
    back: at(-l, 0),
    left: at(0, w),
    right: at(0, -w),
    turn: at(0, w + reach),
  };
}

/** The angle that puts the turn handle at `p`: the handle sits across (+90°) from the length. */
export function angleTowards(c: EditedCourt, p: PlanPoint): number {
  return Math.atan2(p[1] - c.frame.cy, p[0] - c.frame.cx) - Math.PI / 2;
}

/** A sport's court at its standard size, or a 20 × 10 m one where it has none. */
export function standardSize(sport: string): { length: number; width: number } {
  const m = markingsFor(sport);
  return m ? { length: m.length, width: m.width } : { length: 20, width: 10 };
}

/** The unit rectangle a drawn court starts as. */
const RECTANGLE: PlanPoint[] = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [0.5, 0.5],
  [-0.5, 0.5],
];

/**
 * A new court of the sport's standard size, east-west, two metres east of
 * everything already on the plan (or on the venue's point when nothing is).
 */
export function placed(sport: string, others: PlanPoint[][]): EditedCourt {
  const { length, width } = standardSize(sport);
  const points = others.flat();
  if (points.length === 0) {
    return { frame: { cx: 0, cy: 0, angle: 0, length, width }, shape: RECTANGLE };
  }
  const right = Math.max(...points.map((p) => p[0]));
  const bottom = Math.min(...points.map((p) => p[1]));
  return {
    frame: { cx: right + 2 + length / 2, cy: bottom + width / 2, angle: 0, length, width },
    shape: RECTANGLE,
  };
}

/** Whether two outlines are the same, to the centimetre. */
export function sameOutline(a: PlanPoint[] | null, b: PlanPoint[] | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.length === b.length &&
    a.every((p, i) => Math.abs(p[0] - b[i]![0]) < 0.005 && Math.abs(p[1] - b[i]![1]) < 0.005)
  );
}
