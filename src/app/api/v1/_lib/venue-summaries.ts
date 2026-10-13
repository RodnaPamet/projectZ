import type { PrismaClient } from '@prisma/client';

import { listVenues, type VenueFilter } from '@/app-layer/repositories/venue';
import type { V1Page } from '@/lib/data/keys';

import { toVenueSummary, type VenueSummary } from './dto';

/**
 * One page of public venue cards: what `GET /api/v1/venues` answers and what
 * /venues seeds its list with (#332). One function, so the seed is exactly
 * what the endpoint returns for the same key. A difference would make the
 * first revalidation swap one list for another under the person's thumb.
 *
 * Each card carries its club's slug, looked up once over the page's distinct
 * clubs (`id` and `slug` only; the slug is in every public club URL). A venue
 * whose club row is gone is left out: `venue.tenantId` is not a foreign key,
 * so a venue can outlive its club, and a card linking to a club that isn't
 * there is a dead end, and an empty slug would send a client to
 * `/t//bookings`. Dropping one can make a page shorter than `limit`;
 * `nextCursor` is still the last venue READ, so paging neither repeats nor
 * skips.
 *
 * Call it on a BYPASSRLS binding: a public search has no tenant to bind, and
 * what keeps it safe is `publicVenueFilter` inside `listVenues` and the
 * hand-written DTO, not the tenant policy.
 */
export async function listVenueSummaries(
  db: PrismaClient,
  filter: VenueFilter,
  opts: { cursor?: string; limit?: number } = {},
): Promise<V1Page<VenueSummary>> {
  const result = await listVenues(db, filter, opts);

  const tenantIds = [...new Set(result.items.map((v) => v.tenantId))];
  const clubs = tenantIds.length
    ? await db.venueOrg.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, slug: true },
        take: tenantIds.length,
      })
    : [];
  const slugs = new Map(clubs.map((c) => [c.id, c.slug]));

  return {
    items: result.items.flatMap((v) => {
      const clubSlug = slugs.get(v.tenantId);
      return clubSlug ? [toVenueSummary(v, clubSlug)] : [];
    }),
    nextCursor: result.nextCursor,
  };
}
