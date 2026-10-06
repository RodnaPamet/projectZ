import { Prisma, type PrismaClient, type SportType } from '@prisma/client';

import { publicVenueFilter } from './public-venue';

/**
 * Geo search.
 *
 * ─── Why `geography`, not `geometry` ─────────────────────────────────
 *
 * `geography(Point, 4326)` does SPHERICAL math on the WGS-84 ellipsoid, so
 * `ST_DWithin` takes METRES and the answer is a real distance.
 *
 * `geometry` on lat/lng does PLANAR math on DEGREES. At Sofia's latitude a
 * degree of longitude is ~74km and a degree of latitude ~111km, so a
 * "10 unit" radius is an ellipse, not a circle — and every distance is wrong
 * in a way that looks entirely plausible until someone drives to a venue that
 * was supposedly 5km away.
 *
 * ─── Why the radius is capped ────────────────────────────────────────
 *
 * `/api/venues/near` is public and unauthenticated. Without a cap, one GET
 * asking for a 20,000km radius scans the whole table and sorts it. A ceiling
 * is not a nicety here; it is the difference between an endpoint and a DoS.
 */

export const MAX_RADIUS_KM = 50;
export const MAX_GEO_RESULTS = 50;

export class InvalidCoordinateError extends Error {
  constructor(what: string, value: unknown) {
    super(`Invalid ${what}: ${JSON.stringify(value)}`);
    this.name = 'InvalidCoordinateError';
  }
}

export interface NearVenueRow {
  id: string;
  slug: string;
  name: string;
  city: string;
  country: string;
  distanceKm: number;
  avgRating: number;
  reviewCount: number;
}

/**
 * Validate BEFORE the value reaches SQL.
 *
 * The query below uses `Prisma.sql` with bound parameters, so injection is
 * impossible regardless. This is defence in depth *and* a better error: a
 * caller passing `lat=999` gets a 400 naming the problem, instead of a
 * PostGIS error about a point outside the ellipsoid.
 */
function assertCoords(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new InvalidCoordinateError('latitude (expected -90..90)', lat);
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new InvalidCoordinateError('longitude (expected -180..180)', lng);
  }
}

export function clampRadiusKm(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) return 10;
  return Math.min(requested, MAX_RADIUS_KM);
}

export async function nearVenues(
  db: PrismaClient,
  params: { lat: number; lng: number; radiusKm?: number; sport?: SportType; limit?: number },
): Promise<NearVenueRow[]> {
  const { lat, lng } = params;
  assertCoords(lat, lng);

  const radiusM = clampRadiusKm(params.radiusKm) * 1000;
  const limit = Math.min(params.limit ?? 20, MAX_GEO_RESULTS);

  // Prisma.sql with `${}` interpolation produces BOUND PARAMETERS, not string
  // concatenation. `$queryRawUnsafe` with a template literal would be a
  // textbook injection: `lng` comes straight off a query string.
  const sportFilter = params.sport
    ? Prisma.sql`
        AND EXISTS (
          SELECT 1 FROM "court" r
           WHERE r."venueId" = v.id
             AND r.status = 'ACTIVE'
             AND r.sport = ${params.sport}::"SportType"
        )`
    : Prisma.empty;

  const publicVenue = await publicVenueFilter(db);
  // guardrail-allow: cross-tenant — "venues near me" is the public discovery
  // read. A player looking for a court within 5km does not know which club
  // owns it. Same rationale as listVenues, and the same predicate (#298).
  const rows = await db.$queryRaw<Array<NearVenueRow & { distancem: number }>>(Prisma.sql`
    SELECT
      v.id,
      v.slug,
      v.name,
      v.city,
      v.country,
      v."avgRating",
      v."reviewCount",
      ST_Distance(v.geog, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography) AS distancem
    FROM "venue" v
    WHERE v.geog IS NOT NULL
      AND ${publicVenue.sql('v')}
      -- ST_DWithin is the INDEXED predicate (GiST). Filtering on
      -- ST_Distance(...) < r instead would compute the distance for every
      -- venue in the table before discarding almost all of them.
      AND ST_DWithin(
            v.geog,
            ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
            ${radiusM}
          )
      ${sportFilter}
    ORDER BY distancem ASC
    LIMIT ${limit}
  `);

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    city: r.city,
    country: r.country,
    avgRating: Number(r.avgRating),
    reviewCount: r.reviewCount,
    distanceKm: Math.round((r.distancem / 1000) * 10) / 10,
  }));
}
