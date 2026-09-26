import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Courts, for the venue-staff surface.
 *
 * ═══ THE MODEL IS `Resource`, THE TABLE IS `court` ═══
 *
 * `prisma/schema/venue.prisma` renamed the model to `Resource` — a padel court,
 * a football pitch, a chess table and a climbing route are the same bookable
 * thing — and deliberately left `@@map("court")` alone, because renaming the
 * table and its foreign keys in one migration risks the EXCLUDE constraint that
 * is the only thing preventing double-booking.
 *
 * The admin screen is called "Courts" because that is what a Bulgarian padel
 * club calls them. Both names are correct at their own layer; this file is
 * where they meet.
 *
 * ═══ NO BINDING IN HERE ═══
 *
 * Every function takes `db`. The caller decides which RLS context it is asking
 * for, which for anything in this file is `runInTenantContext` — these rows are
 * tenant-scoped and there is no legitimate cross-club court query.
 */

/** What the list screen shows. Deliberately not the whole row. */
export const COURT_LIST_SELECT = {
  id: true,
  name: true,
  sport: true,
  resourceType: true,
  surface: true,
  isIndoor: true,
  capacity: true,
  status: true,
  basePriceCents: true,
  currency: true,
  minBookingMinutes: true,
  maxBookingMinutes: true,
  slotStepMinutes: true,
  venueId: true,
  venue: { select: { id: true, name: true } },
} satisfies Prisma.ResourceSelect;

export type CourtListItem = Prisma.ResourceGetPayload<{ select: typeof COURT_LIST_SELECT }>;

/**
 * Every court at this club, newest venue grouping first.
 *
 * ═══ BOUNDED, AND WHY THE BOUND IS WHERE IT IS ═══
 *
 * `take` is not optional — `query-shape`'s D2 rule fails any `findMany`
 * without one, because a query that returns three rows in development returns
 * two hundred thousand in production and takes the page with it.
 *
 * 500 is far above any real club (the largest padel venues in Sofia have
 * fewer than 20 courts) and far below a problem. A club that exceeds it has
 * outgrown a single-page list and wants paging, which is a different screen.
 */
export const COURT_LIST_LIMIT = 500;

export async function listCourts(
  db: PrismaClient,
  /**
   * Belt AND braces, deliberately.
   *
   * The caller binds `runInTenantContext`, so row security already constrains
   * this. Passing the id as well means the query is correct even where RLS is
   * not applying — a job or admin path running as `app_superuser` bypasses it
   * entirely, and there the missing filter stops being a silent empty list and
   * becomes a cross-club leak. `tenant-isolation-structural` requires this for
   * exactly that reason.
   */
  tenantId: string,
  opts: { venueId?: string; includeArchived?: boolean } = {},
): Promise<CourtListItem[]> {
  return db.resource.findMany({
    where: {
      tenantId,
      ...(opts.venueId ? { venueId: opts.venueId } : {}),
      // CLOSED is the archive. Hiding it by default keeps a decommissioned
      // court out of the working list without deleting rows that bookings,
      // payments and the ledger still reference.
      ...(opts.includeArchived ? {} : { status: { not: 'CLOSED' } }),
    },
    select: COURT_LIST_SELECT,
    // Grouped by venue, then by name, so a club with two sites reads as two
    // sections rather than an interleaved list. `id` breaks ties because
    // `name` carries no unique constraint — two courts may share one.
    orderBy: [{ venueId: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    take: COURT_LIST_LIMIT,
  });
}

/** Whether the list was truncated, so the screen can say so rather than lie. */
export function courtsWereTruncated(rows: readonly unknown[]): boolean {
  return rows.length >= COURT_LIST_LIMIT;
}
