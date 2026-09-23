import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Venue reads.
 *
 * EVERY findMany here sets `take`. An unbounded list is a production
 * incident waiting for your most successful customer: it works perfectly
 * with the 12 seeded venues and falls over the day someone has 50,000
 * bookings. The `query-shape` guardrail fails the build if a `take` is
 * missing.
 */

/** Hard ceiling. A client asking for 10,000 gets 50. */
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;

export interface VenueFilter {
  q?: string;
  city?: string;
  sport?: Prisma.EnumSportTypeFilter['equals'];
  indoor?: boolean;
  maxPriceCents?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function clampLimit(requested?: number): number {
  if (!requested || requested < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(requested, MAX_PAGE_SIZE);
}

/**
 * Public venue search — deliberately CROSS-TENANT.
 *
 * A player looking for a padel court in Sofia does not know or care which
 * club owns it. This is the one read that must span tenants, so it runs
 * outside the RLS-bound path and filters on `status` explicitly.
 */
export async function listVenues(
  db: PrismaClient,
  filter: VenueFilter,
  opts: { cursor?: string; limit?: number } = {},
): Promise<Page<Prisma.VenueGetPayload<{ include: { resources: true } }>>> {
  const take = clampLimit(opts.limit);

  const where: Prisma.VenueWhereInput = {
    status: 'ACTIVE',
    ...(filter.city ? { city: { equals: filter.city, mode: 'insensitive' } } : {}),
    ...(filter.q
      ? {
          OR: [
            { name: { contains: filter.q, mode: 'insensitive' } },
            { city: { contains: filter.q, mode: 'insensitive' } },
          ],
        }
      : {}),
    ...(filter.sport || filter.indoor !== undefined || filter.maxPriceCents
      ? {
          resources: {
            some: {
              status: 'ACTIVE',
              ...(filter.sport ? { sport: filter.sport } : {}),
              ...(filter.indoor !== undefined ? { isIndoor: filter.indoor } : {}),
              ...(filter.maxPriceCents ? { basePriceCents: { lte: filter.maxPriceCents } } : {}),
            },
          },
        }
      : {}),
  };

  // guardrail-allow: cross-tenant — public venue search is intentionally
  // unscoped. A player hunting a padel court in Sofia does not know or care
  // which club owns it. `status: ACTIVE` is the only filter, and an
  // integration test asserts this did not weaken RLS for anything else.
  const rows = await db.venue.findMany({
    where,
    include: { resources: { where: { status: 'ACTIVE' }, take: 20 } },
    orderBy: { id: 'asc' },
    // take + 1 so we can tell "there is a next page" WITHOUT a second
    // count(*) query, which on a large table is the expensive half.
    take: take + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;

  return {
    items,
    nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
  };
}

/**
 * Public venue detail, BY ID and deliberately cross-tenant.
 *
 * Not by slug: `@@unique([tenantId, slug])` means slugs are unique WITHIN a
 * tenant, so two clubs can both own `central-courts`. A public route that has
 * only a slug cannot say which one it means, and picking the first match would
 * be a coin flip that occasionally shows the wrong club's opening hours.
 *
 * Ids are cuids and globally unique. The list endpoint returns them, and a
 * native client follows ids — slugs are an SEO concern for the web, not a
 * client-facing identifier.
 */
export async function getVenueById(db: PrismaClient, venueId: string) {
  // guardrail-allow: cross-tenant — the public detail read, reached from the
  // public index. Same rationale as listVenues: a player opening a venue card
  // does not know which club owns it. `status: ACTIVE` is the only filter.
  return db.venue.findFirst({
    where: { id: venueId, status: 'ACTIVE' },
    include: {
      resources: { where: { status: 'ACTIVE' }, orderBy: { name: 'asc' }, take: 50 },
      photos: { orderBy: { position: 'asc' }, take: 20 },
      amenities: { take: 30 },
    },
  });
}

export async function getVenueBySlug(db: PrismaClient, tenantId: string, venueSlug: string) {
  return db.venue.findFirst({
    // tenantId is redundant under RLS — the policy adds it anyway. It is
    // here so the query is still correct if it is ever run as superuser.
    where: { tenantId, slug: venueSlug, status: 'ACTIVE' },
    include: {
      resources: { where: { status: 'ACTIVE' }, orderBy: { name: 'asc' }, take: 50 },
      photos: { orderBy: { position: 'asc' }, take: 20 },
      amenities: { take: 30 },
    },
  });
}
