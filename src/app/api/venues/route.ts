import { type NextRequest, NextResponse } from 'next/server';

import { runAsSuperuser } from '@/lib/db/rls-middleware';
import { isSportKey } from '@/lib/sports/registry';
import { clampLimit, listVenues } from '@/app-layer/repositories/venue';

/**
 * Public venue search. Deliberately cross-tenant and unauthenticated — a
 * player looking for a padel court in Sofia does not know which club owns
 * it.
 *
 * `clampLimit` is not advisory. Without a ceiling this is a one-request DoS:
 * an unauthenticated GET asking for a million rows.
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

  // BYPASSRLS, not the raw singleton. `venue` has FORCE RLS keyed on
  // app.tenant_id and this read has no tenant, so bound as app_user it returns
  // ZERO ROWS — an empty city, silently. It only appeared to work because the
  // dev connection role is a cluster superuser and is exempt from row security.
  const page = await runAsSuperuser((db) =>
    listVenues(
      db,
      {
        q: sp.get('q') ?? undefined,
        city: sp.get('city') ?? undefined,
        sport,
        indoor: sp.has('indoor') ? sp.get('indoor') === 'true' : undefined,
        maxPriceCents: sp.has('maxPrice') ? Number(sp.get('maxPrice')) : undefined,
      },
      {
        cursor: sp.get('cursor') ?? undefined,
        limit: clampLimit(sp.has('limit') ? Number(sp.get('limit')) : undefined),
      },
    ),
  );

  return NextResponse.json({
    venues: page.items.map((v) => ({
      id: v.id,
      slug: v.slug,
      name: v.name,
      city: v.city,
      country: v.country,
      avgRating: Number(v.avgRating),
      reviewCount: v.reviewCount,
      sports: [...new Set(v.resources.map((c) => c.sport))],
      fromPriceCents: v.resources.length
        ? Math.min(...v.resources.map((c) => c.basePriceCents))
        : null,
    })),
    nextCursor: page.nextCursor,
  });
}
