import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * WHICH VENUES THE PUBLIC MAY SEE (#298). The one definition.
 *
 * A venue is public when the venue is ACTIVE **and its club is ACTIVE**. A
 * SUSPENDED or CLOSED club leaves its venue rows `status: ACTIVE` (nothing sets
 * club status yet, #254, but the column exists and is respected), and before
 * this the index, the filters, `near` and the v1 detail all kept listing them,
 * so their cards led to a venue page that 404s.
 *
 * Every public venue read (the /venues index and its filters, `GET
 * /api/v1/venues`, `/{id}`, `/{id}/availability`, `/near`, `/api/venues`, the
 * venue page and the sitemap) filters through `publicVenueFilter`. The
 * `public-venue-reads` guardrail fails the build when a venue read with no
 * tenant scope does not, so the rule cannot drift back to `status: ACTIVE`
 * alone.
 *
 * ═══ WHY A LIST OF HIDDEN CLUBS, NOT A JOIN ═══
 *
 * `venue.tenantId` is not a foreign key: `Venue` has no relation to `VenueOrg`,
 * so Prisma cannot say `tenant: { status: 'ACTIVE' }`. Filtering after the read
 * would break paging (a page of 20 coming back with 17) and the DISTINCT facet
 * reads. So the clubs that are NOT active are read first, one small query, and
 * excluded in SQL: `tenantId NOT IN (…)`. Paging, cursors, DISTINCT and `near`'s
 * LIMIT all stay correct, because the excluded rows never reach them.
 *
 * Excluding the non-active rather than including the active keeps the list
 * short: a handful of suspended clubs, not every club in the country.
 *
 * A venue whose club row does not exist at all (possible without the foreign
 * key) is not excluded here. Every caller that links somewhere needs the club's
 * slug and already drops a venue it cannot find one for.
 */

/** More than this many suspended or closed clubs: refuse rather than show one. */
export const MAX_HIDDEN_CLUBS = 10_000;

export interface PublicVenueFilter {
  /** For a Prisma `venue` where, or a relation filter on `venue`. Combine with `AND`. */
  where: Prisma.VenueWhereInput;
  /** The same predicate for raw SQL, against the venue table aliased as `alias`. */
  sql(alias: string): Prisma.Sql;
}

export async function publicVenueFilter(db: PrismaClient): Promise<PublicVenueFilter> {
  const hidden = await db.venueOrg.findMany({
    where: { status: { not: 'ACTIVE' } },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: MAX_HIDDEN_CLUBS + 1,
  });

  // Fail closed. A truncated list would silently show the venues of the clubs
  // past the cut, which is the bug this file exists to prevent. Reaching this
  // means it is time for a foreign key and a join instead.
  if (hidden.length > MAX_HIDDEN_CLUBS) {
    throw new Error(
      `publicVenueFilter: more than ${MAX_HIDDEN_CLUBS} suspended or closed clubs; ` +
        'the exclusion list no longer scales. Join venue to venue_org instead.',
    );
  }

  const ids = hidden.map((c) => c.id);

  return {
    where: { status: 'ACTIVE', ...(ids.length > 0 ? { tenantId: { notIn: ids } } : {}) },
    sql(alias) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
        throw new Error(`publicVenueFilter: not an SQL alias: ${JSON.stringify(alias)}`);
      }
      const v = Prisma.raw(alias);
      return ids.length > 0
        ? Prisma.sql`${v}.status = 'ACTIVE' AND ${v}."tenantId" NOT IN (${Prisma.join(ids)})`
        : Prisma.sql`${v}.status = 'ACTIVE'`;
    },
  };
}
