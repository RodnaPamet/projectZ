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

/** A court on the plan, as `GET /venues/{id}/plan` answers it. */
export interface VenuePlanCourt {
  resourceId: string;
  name: string;
  sport: string;
  resourceType: string;
  outline: PlanPoint[];
  source: 'OSM' | 'CLUB';
}

/** One of the plan's other shapes: the grounds, a building, an entrance. */
export interface VenuePlanShape {
  kind: 'GROUNDS' | 'BUILDING' | 'ENTRANCE';
  outline: PlanPoint[];
  source: 'OSM' | 'CLUB';
}

export interface VenuePlan {
  venueId: string;
  courts: VenuePlanCourt[];
  features: VenuePlanShape[];
  /** `OpenStreetMap` while any shape shown came from OSM (ODbL). */
  attribution: 'OpenStreetMap' | null;
}

/** The rows `getVenuePlan` reads, as stored. */
interface StoredPlan {
  id: string;
  resources: {
    id: string;
    name: string;
    sport: string;
    resourceType: string;
    planOutline: unknown;
    planSource: 'OSM' | 'CLUB' | null;
  }[];
  planFeatures: { kind: VenuePlanShape['kind']; outline: unknown; source: 'OSM' | 'CLUB' }[];
}

/**
 * The plan as clients get it, from the API and on the venue page alike. A
 * court with no outline, or one that is not a sane polygon, is not on it; no
 * courts on it means no plan, and then no other shape either.
 */
export function toVenuePlan(venue: StoredPlan): VenuePlan {
  const courts = venue.resources.flatMap((r) => {
    const outline = parseOutline(r.planOutline);
    return outline && r.planSource
      ? [
          {
            resourceId: r.id,
            name: r.name,
            sport: r.sport,
            resourceType: r.resourceType,
            outline,
            source: r.planSource,
          },
        ]
      : [];
  });
  const features = venue.planFeatures.flatMap((f) => {
    const outline = parseOutline(f.outline);
    return outline ? [{ kind: f.kind, outline, source: f.source }] : [];
  });
  const fromOsm = [...courts, ...features].some((shape) => shape.source === 'OSM');
  return {
    venueId: venue.id,
    courts,
    features: courts.length > 0 ? features : [],
    attribution: fromOsm && courts.length > 0 ? 'OpenStreetMap' : null,
  };
}
