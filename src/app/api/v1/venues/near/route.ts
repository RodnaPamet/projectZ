import { type NextRequest } from 'next/server';

import { clampRadiusKm, MAX_GEO_RESULTS, nearVenueIds } from '@/app-layer/repositories/geo';
import { listVenuesByIds } from '@/app-layer/repositories/venue';
import { asSuperuser } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { ok } from '@/app/api/v1/_lib/envelope';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

import { sportParam } from '../../_lib/sport-param';
import { toSummaries } from '../../_lib/venue-summaries';

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
 * ═══ A CARD, LIKE THE LIST'S (#667) ═══
 *
 * Each venue is a `VenueSummary` plus `distanceKm`, and the list's filters
 * (`city`, `q`, `indoor`, `maxPrice`, `sport`) apply here too: «Близо до мен»
 * on the phone shows the same card with the same filters as the list. The
 * ids come from the geo search (nearest first, at most NEAR_CANDIDATES), the
 * cards from `listVenuesByIds`, then the distance order and the cap.
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
  // An unknown sport is a 400 here, not an invalid enum in the SQL (#334).
  const sport = sportParam(sp.get('sport'));

  const requested = sp.has('limit') ? Number(sp.get('limit')) : NaN;
  const limit = Number.isFinite(requested) && requested >= 1 ? Math.min(requested, MAX_GEO_RESULTS) : 20;

  const venues = await asSuperuser(ctx, async (db) => {
    const near = await nearVenueIds(db, { lat, lng, radiusKm });
    const distance = new Map(near.map((n) => [n.id, n.distanceKm]));
    const rows = await listVenuesByIds(db, [...distance.keys()], {
      q: sp.get('q') ?? undefined,
      city: sp.get('city') ?? undefined,
      sport,
      indoor: sp.has('indoor') ? sp.get('indoor') === 'true' : undefined,
      maxPriceCents: sp.has('maxPrice') ? Number(sp.get('maxPrice')) : undefined,
    });
    const cards = await toSummaries(db, rows);
    return cards
      .map((c) => ({ ...c, distanceKm: distance.get(c.id)! }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, limit);
  });

  // The echoed radius and cap are part of the contract: a client that asked for
  // 500km and got 50 needs to know its request was clamped, or it will render
  // "no venues within 500km" when it never searched that far.
  return ok({ venues, radiusKm, maxResults: MAX_GEO_RESULTS, paginated: false });
}

export const GET = defineV1Route(handler);
