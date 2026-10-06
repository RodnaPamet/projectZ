import { type NextRequest } from 'next/server';

import { clampLimit, listVenues } from '@/app-layer/repositories/venue';
import { asSuperuser } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { toVenueSummary } from '@/app/api/v1/_lib/dto';
import { page } from '@/app/api/v1/_lib/envelope';
import { toV1ErrorResponse } from '@/app/api/v1/_lib/errors';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { getRequestId } from '@/lib/observability/context';

import { sportParam } from '../_lib/sport-param';

/**
 * Public venue search. Cross-tenant, unauthenticated.
 *
 * ═══ WHY asSuperuser, AND WHY THAT IS NOT LAZINESS ═══
 *
 * `venue` carries FORCE ROW LEVEL SECURITY with a policy keyed on
 * `app.tenant_id`. A public search has no tenant — a player hunting a padel
 * court in Sofia does not know which club owns it — so binding `inTenant` is
 * impossible and binding nothing fails closed.
 *
 * Measured against the database:
 *
 *     app_user, no tenant bound   0 rows
 *     app_superuser               1 row
 *
 * The non-versioned `/api/venues` passes the raw Prisma singleton instead. That
 * works today ONLY because the dev connection role is a cluster superuser and
 * is exempt from row security. Point it at the least-privileged role from P24
 * and that route returns an empty list, silently, in production.
 *
 * So the BYPASSRLS binding is the correct one here, and `publicVenueFilter` (#298) plus
 * the hand-written DTO are what keep it safe rather than the tenant policy.
 */
async function handler(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  // Before the transaction: an unknown sport is a 400 naming the parameter,
  // not an invalid enum value inside Prisma (a 500, #334).
  const sport = sportParam(sp.get('sport'));

  const { result, clubSlugs } = await asSuperuser(ctx, async (db) => {
    const result = await listVenues(
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
        // Not advisory. Without a ceiling this is a one-request DoS: an
        // unauthenticated GET asking for a million rows.
        limit: clampLimit(sp.has('limit') ? Number(sp.get('limit')) : undefined),
      },
    );

    // ═══ THE CLUB SLUG, ONE QUERY PER PAGE ═══
    //
    // `Venue` carries a `tenantId` column and no relation to `VenueOrg`, so
    // the slug cannot ride along in the `include`. One lookup over the page's
    // distinct clubs — at most `clampLimit`'s 50 ids, usually far fewer — in
    // the same BYPASSRLS transaction, because `venue_org` is no more readable
    // unbound than `venue` is. It returns only `id` and `slug`: the slug is in
    // every public `/t/{slug}` URL already, and nothing else is selected.
    const tenantIds = [...new Set(result.items.map((v) => v.tenantId))];
    const clubs = tenantIds.length
      ? await db.venueOrg.findMany({
          where: { id: { in: tenantIds } },
          select: { id: true, slug: true },
          take: tenantIds.length,
        })
      : [];

    return { result, clubSlugs: new Map(clubs.map((c) => [c.id, c.slug])) };
  });

  // ═══ A VENUE WITH NO CLUB IS LEFT OUT, NOT GIVEN AN EMPTY SLUG ═══
  //
  // `venue.tenantId` is NOT a foreign key (the p05 migration indexes it and
  // constrains nothing), so a venue can outlive its club row. Such a venue
  // cannot be booked — every booking route needs the club's slug — and an
  // empty `clubSlug` would send a client to `/t//bookings`. Dropping it can
  // make a page one shorter than `limit`; `nextCursor` is still the last
  // venue READ, so paging neither repeats nor skips.
  const items = result.items.flatMap((v) => {
    const clubSlug = clubSlugs.get(v.tenantId);
    return clubSlug ? [toVenueSummary(v, clubSlug)] : [];
  });

  return page(items, result.nextCursor);
}

export const GET = defineV1Route(handler);
