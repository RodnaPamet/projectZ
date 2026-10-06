import { type NextRequest, NextResponse } from 'next/server';

import { InvalidCoordinateError, clampRadiusKm, nearVenues } from '@/app-layer/repositories/geo';
import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { isSportKey } from '@/lib/sports/registry';

/**
 * "Venues near me". Public, unauthenticated.
 *
 * The radius is capped inside `nearVenues` — not here — so the ceiling holds
 * for every caller, including a job or an admin page that forgets to clamp.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  // An unknown sport is a 400, not an invalid enum inside the query (#334).
  const sport = sp.get('sport') || undefined;
  if (sport !== undefined && !isSportKey(sport)) {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid sport', details: { field: 'sport' } } },
      { status: 400 },
    );
  }

  const lat = Number(sp.get('lat'));
  const lng = Number(sp.get('lng'));
  const radiusKm = sp.has('radius') ? Number(sp.get('radius')) : undefined;

  try {
    // BYPASSRLS — see /api/venues. A public geo read has no tenant to bind.
    const venues = await runAsSuperuser((db) =>
      nearVenues(db, {
        lat,
        lng,
        radiusKm,
        sport,
        limit: sp.has('limit') ? Number(sp.get('limit')) : undefined,
      }),
    );

    return NextResponse.json({
      venues,
      radiusKm: clampRadiusKm(radiusKm),
    });
  } catch (e) {
    if (e instanceof InvalidCoordinateError) {
      // 400, with the reason. A PostGIS error about a point outside the
      // ellipsoid is not something a caller can act on.
      // `detail` (singular) was a third shape again; the canonical
      // envelope's optional field is `details`.
      return NextResponse.json(
        { error: { code: 'BAD_REQUEST', message: 'Invalid coordinates', details: e.message } },
        { status: 400 },
      );
    }
    throw e;
  }
}
