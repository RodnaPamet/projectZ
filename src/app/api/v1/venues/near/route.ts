import { type NextRequest } from 'next/server';

import { clampRadiusKm, MAX_GEO_RESULTS, nearVenues } from '@/app-layer/repositories/geo';
import { asSuperuser } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { ok } from '@/app/api/v1/_lib/envelope';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * Venues near a point. Public, cross-tenant, unauthenticated.
 *
 * ═══ DELIBERATELY NOT PAGINATED ═══
 *
 * This returns one capped page ordered by distance, and that is the design
 * rather than an omission.
 *
 * A keyset cursor cannot be built on distance without pinning the origin: the
 * user walks between pages, every distance shifts, and a venue that was on page
 * one reappears on page two — or vanishes. An offset cursor is worse, because
 * it silently skips rows when the set changes underneath it.
 *
 * "Venues near me" is not a list anyone pages through. The way to see different
 * results is a different radius, which is a parameter. So the endpoint caps at
 * MAX_GEO_RESULTS and says so in the response rather than pretending there is
 * a page two.
 *
 * ═══ THE RADIUS CAP IS NOT A NICETY ═══
 *
 * Unauthenticated, and the wrapper cannot rate-limit a GET
 * (`resolveRateLimitScope` bails on non-mutating methods before reading its
 * options). Without `clampRadiusKm`, one request asking for a 20,000km radius
 * scans the table and sorts it. The cap is the only thing standing between this
 * route and a DoS.
 */
function coord(raw: string | null, what: string): number {
  // Parsed and rejected HERE so a bad query string is a 400 naming the
  // parameter, rather than a PostGIS error about a point outside the ellipsoid.
  // `Number('')` is 0, which would silently locate the caller off West Africa.
  if (raw === null || raw.trim() === '') throw new ValidationError(`Missing ${what}`);

  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ValidationError(`Invalid ${what}: ${raw}`);
  return n;
}

async function handler(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });

  const lat = coord(sp.get('lat'), 'lat');
  const lng = coord(sp.get('lng'), 'lng');
  const radiusKm = clampRadiusKm(sp.has('radiusKm') ? Number(sp.get('radiusKm')) : undefined);

  const venues = await asSuperuser(ctx, (db) =>
    nearVenues(db, {
      lat,
      lng,
      radiusKm,
      sport: (sp.get('sport') as never) ?? undefined,
      limit: sp.has('limit') ? Number(sp.get('limit')) : undefined,
    }),
  );

  // The echoed radius and cap are part of the contract: a client that asked for
  // 500km and got 50 needs to know its request was clamped, or it will render
  // "no venues within 500km" when it never searched that far.
  return ok({ venues, radiusKm, maxResults: MAX_GEO_RESULTS, paginated: false });
}

export const GET = defineV1Route(handler);
