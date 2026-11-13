import { type NextRequest } from 'next/server';

import { asSuperuser } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import type { VenueSummary } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { getRequestId } from '@/lib/observability/context';

import { sportParam } from '../../_lib/sport-param';
import { listVenueSummaries } from '../../_lib/venue-summaries';

/**
 * Every bookable venue, for the clubs map (#697: owner 2026-11-13, "a map
 * with all the clubs in Bulgaria who are bookable in playerz"). Public,
 * cross-tenant, unauthenticated, as `GET /venues`, with the same filters.
 *
 * The same cards as the list (each `VenueSummary` carries `lat`/`lng`), read
 * page by page through `listVenueSummaries`, so `publicVenueFilter` and the
 * hand-written DTO keep it as safe as the list. Bookable means it has a
 * price: a venue with no ACTIVE court has nothing to book and no pin.
 *
 * ═══ CAPPED ═══
 *
 * A map of a country is not a list anyone pages, so there is no cursor; the
 * read stops at MAX_MAP_VENUES and says so (`truncated`). At Bulgarian scale
 * that is far above what exists; it bounds what one unauthenticated GET
 * reads, as `clampRadiusKm` does for the near search.
 */
const MAX_MAP_VENUES = 1000;
const PAGE = 50;

async function handler(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  const sport = sportParam(sp.get('sport'));
  const filter = {
    q: sp.get('q') ?? undefined,
    city: sp.get('city') ?? undefined,
    sport,
    indoor: sp.has('indoor') ? sp.get('indoor') === 'true' : undefined,
    maxPriceCents: sp.has('maxPrice') ? Number(sp.get('maxPrice')) : undefined,
  };

  const { venues, truncated } = await asSuperuser(ctx, async (db) => {
    const out: VenueSummary[] = [];
    let cursor: string | undefined;
    let read = 0;
    do {
      const page = await listVenueSummaries(db, filter, { cursor, limit: PAGE });
      out.push(...page.items.filter((v) => v.fromPriceCents !== null));
      read += PAGE;
      cursor = page.nextCursor ?? undefined;
    } while (cursor && read < MAX_MAP_VENUES);
    return { venues: out, truncated: Boolean(cursor) };
  });

  return ok({ venues, truncated, maxResults: MAX_MAP_VENUES });
}

export const GET = defineV1Route(handler);
