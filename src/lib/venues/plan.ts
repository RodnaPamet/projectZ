/**
 * The venue plan (#623): where each court lies, drawn by us with no map tiles
 * under it (owner, 2026-10-20).
 *
 * A shape is a polygon of [x, y] points in METRES in the venue's own frame:
 * origin at the venue's point (`venue.lat`/`lng`), x east, y north. Stored as
 * JSON (`Resource.planOutline`, `VenuePlanFeature.outline`), so everything
 * read from the database goes through `parseOutline`: a shape that is not a
 * sane polygon is left off the plan rather than served.
 */

export type PlanPoint = [x: number, y: number];

/** Fewer than three points is not an area; a court never needs hundreds. */
export const OUTLINE_MIN_POINTS = 3;
export const OUTLINE_MAX_POINTS = 64;

/**
 * How far from the venue's point a shape may lie. A venue's grounds fit well
 * inside a kilometre; anything further is a wrong venue point or a wrong way.
 */
export const PLAN_RADIUS_M = 1000;

/** The polygon in `raw`, or null when it is not one the plan can draw. */
export function parseOutline(raw: unknown): PlanPoint[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length < OUTLINE_MIN_POINTS || raw.length > OUTLINE_MAX_POINTS) return null;
  const points: PlanPoint[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [x, y] = p as unknown[];
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (Math.abs(x) > PLAN_RADIUS_M || Math.abs(y) > PLAN_RADIUS_M) return null;
    // Centimetres are plenty for a drawing, and keep the answer small.
    points.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
  }
  return area(points) > 0 ? points : null;
}

/** The polygon's area in m² (shoelace): zero for points on one line. */
export function area(points: PlanPoint[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}
