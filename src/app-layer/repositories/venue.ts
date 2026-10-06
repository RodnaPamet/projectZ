import type { Prisma, PrismaClient, SportType } from '@prisma/client';

import { canonicalCity, citiesMatching, citySpellings } from '@/lib/geo/cities';

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
  /** Already checked against the enum by the caller (#334): see `sportParam`. */
  sport?: SportType;
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

  // A known city matches every way it is spelled (#357): `?city=Sofia` finds a
  // venue a club typed as `София`, and a search for "соф" finds `Sofia`. An
  // unknown city is matched exactly as before. See src/lib/geo/cities.ts.
  const qCities = filter.q ? citiesMatching(filter.q) : [];
  const where: Prisma.VenueWhereInput = {
    status: 'ACTIVE',
    ...(filter.city ? { city: { in: citySpellings(filter.city), mode: 'insensitive' } } : {}),
    ...(filter.q
      ? {
          OR: [
            { name: { contains: filter.q, mode: 'insensitive' } },
            { city: { contains: filter.q, mode: 'insensitive' } },
            ...(qCities.length > 0
              ? [{ city: { in: qCities, mode: 'insensitive' as const } }]
              : []),
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

/** The most cities and sports the /venues filters offer. */
export const MAX_FACETS = 100;

export interface VenueFacets {
  /** Canonical spellings (what `?city=` carries), one per city, sorted. */
  cities: string[];
  sports: SportType[];
}

/**
 * What the /venues filters offer (#357): the cities with a live venue, and
 * the sports with a live court at a live venue. Offering every city in the
 * country, or all sixteen sports, would mostly lead to the empty state.
 *
 * Cross-tenant like `listVenues`, with the same `status: ACTIVE` filters, so
 * a choice offered here finds at least the venue that put it here.
 */
export async function listVenueFacets(db: PrismaClient): Promise<VenueFacets> {
  // guardrail-allow: cross-tenant — the public index's filters span every
  // club, as the index does. Only the distinct city and sport are read.
  const cityRows = await db.venue.findMany({
    where: { status: 'ACTIVE' },
    select: { city: true },
    distinct: ['city'],
    orderBy: { city: 'asc' },
    take: MAX_FACETS,
  });
  // guardrail-allow: cross-tenant — as above.
  const sportRows = await db.resource.findMany({
    where: { status: 'ACTIVE', venue: { status: 'ACTIVE' } },
    select: { sport: true },
    distinct: ['sport'],
    orderBy: { sport: 'asc' },
    take: MAX_FACETS,
  });

  return {
    cities: [...new Set(cityRows.map((r) => canonicalCity(r.city)).filter(Boolean))].sort(),
    sports: sportRows.map((r) => r.sport),
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

/**
 * Public venue detail by its PUBLIC slug (#355), cross-tenant like
 * `getVenueById`. `publicSlug` is unique across every club (P41), so — unlike
 * `slug` — it names exactly one venue, and `/venues/{publicSlug}` can be a
 * readable URL.
 *
 * Resources carry what the venue page needs to offer durations (Q16).
 */
export async function getVenueByPublicSlug(db: PrismaClient, publicSlug: string) {
  // guardrail-allow: cross-tenant — the public venue page, reached from the
  // public index. Same rationale as getVenueById. `status: ACTIVE` is the only
  // filter.
  return db.venue.findFirst({
    where: { publicSlug, status: 'ACTIVE' },
    include: {
      resources: { where: { status: 'ACTIVE' }, orderBy: { name: 'asc' }, take: 50 },
      photos: { orderBy: { position: 'asc' }, take: 20 },
      amenities: { take: 30 },
    },
  });
}

/**
 * Every venue page a search engine should know about (#396's sitemap):
 * ACTIVE venues with a public slug, whose club is ACTIVE too.
 *
 * The club check is its own query because `venue.tenantId` is not a foreign
 * key (no relation to join through). It is not optional: a SUSPENDED or
 * CLOSED club's venues are still `status: ACTIVE` rows — the v1 detail route
 * returns them (#298) — but the venue page 404s them, and a sitemap that
 * lists 404s is one a crawler learns to distrust.
 *
 * Bounded by `limit` (the caller passes the sitemap's per-file cap) and
 * ordered by slug, so a cut, if it ever happens, is stable between crawls.
 */
export async function listSitemapVenues(
  db: PrismaClient,
  limit: number,
): Promise<Array<{ publicSlug: string; updatedAt: Date; tenantId: string }>> {
  // guardrail-allow: cross-tenant — the sitemap lists every club's public
  // venue pages, the same set the public index and venue pages show.
  const venues = await db.venue.findMany({
    where: { status: 'ACTIVE', publicSlug: { not: null } },
    select: { publicSlug: true, updatedAt: true, tenantId: true },
    orderBy: { publicSlug: 'asc' },
    take: limit,
  });
  const clubIds = [...new Set(venues.map((v) => v.tenantId))];
  if (clubIds.length === 0) return [];
  const active = await db.venueOrg.findMany({
    where: { id: { in: clubIds }, status: 'ACTIVE' },
    select: { id: true },
    take: clubIds.length,
  });
  const activeIds = new Set(active.map((c) => c.id));
  return venues.flatMap((v) =>
    v.publicSlug && activeIds.has(v.tenantId)
      ? [{ publicSlug: v.publicSlug, updatedAt: v.updatedAt, tenantId: v.tenantId }]
      : [],
  );
}

/**
 * Every club page a search engine should know about (#356): ACTIVE clubs with
 * at least one venue on the sitemap. A club page with no venue is an empty
 * shell — a "soft 404" to a crawler — so it waits until it has one.
 *
 * Built from `listSitemapVenues`' answer, so the two cannot disagree about
 * which clubs are live, plus one lookup for the slugs. `lastModified` is the
 * newer of the club row and its newest venue: the page shows both.
 */
export async function listSitemapClubs(
  db: PrismaClient,
  venues: ReadonlyArray<{ tenantId: string; updatedAt: Date }>,
): Promise<Array<{ slug: string; updatedAt: Date }>> {
  const newest = new Map<string, Date>();
  for (const v of venues) {
    const seen = newest.get(v.tenantId);
    if (!seen || v.updatedAt > seen) newest.set(v.tenantId, v.updatedAt);
  }
  if (newest.size === 0) return [];
  // guardrail-allow: cross-tenant — the sitemap lists every club's public
  // page; only the slug and the date are read.
  const clubs = await db.venueOrg.findMany({
    where: { id: { in: [...newest.keys()] }, status: 'ACTIVE' },
    select: { id: true, slug: true, updatedAt: true },
    orderBy: { slug: 'asc' },
    take: newest.size,
  });
  return clubs.map((c) => {
    const venueDate = newest.get(c.id)!;
    return { slug: c.slug, updatedAt: venueDate > c.updatedAt ? venueDate : c.updatedAt };
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
