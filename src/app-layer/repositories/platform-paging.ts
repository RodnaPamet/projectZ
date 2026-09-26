import type { PrismaClient } from '@prisma/client';

/**
 * Keyset paging for the platform reads, as a true index SEEK.
 *
 * ═══ WHAT WAS MEASURED ═══
 *
 * 500 000 rows in `platform_audit_entry`, deliberately BURSTY: 5 000 distinct
 * timestamps with 100 rows sharing each, because audit entries arrive in
 * batches and a fixture with unique timestamps hides every tie-break cost.
 * Deep page = row 10 000. Medians of 7 warm runs, net of the 1.6 ms the
 * enclosing admin transaction costs, all with P34's composite index present:
 *
 *   Prisma cursor        18.4 ms
 *   Prisma OR form       17.4 ms
 *   raw row-value seek    7.6 ms
 *
 * 2.4× on a page, and a full 10 000-page walk is 184 s against 76 s. An
 * investigator reading an audit log is exactly the person who walks the whole
 * thing.
 *
 * ═══ WHY NOT THE OR FORM, WHICH NEEDS NO RAW SQL ═══
 *
 * Not because it is slow — at 17.4 ms it is a hair FASTER than the cursor it
 * would replace (0.95×), and an earlier note in this file claiming it was
 * *worse* was measured before the composite index existed and is withdrawn.
 * It is simply that neither Prisma form seeks: both scan from the top of the
 * index and discard. `src/lib/pagination.ts` already emits the OR form, and
 * switching to it would buy nothing measurable.
 *
 * So the honest trade is 2.4× against raw SQL in a feature where raw SQL has
 * already caused one authorisation bug. Taken because the audit log is the one
 * table walked end to end; NOT a precedent for tenant-scoped reads, which page
 * shallowly and stay on the query builder.
 *
 * ═══ HOW THE KNOWN FOOTGUN IS AVOIDED ═══
 *
 * `$queryRawUnsafe` returns a Postgres enum ARRAY as the string
 * `"{TENANT_READ}"`. That is how `ctx.appPermissions` came to hold a string
 * while typed as an array, turning `.includes()` into substring matching in
 * the code deciding who may read every club.
 *
 * So these return IDS AND NOTHING ELSE — `text` columns, no enums, no dates,
 * no Decimals. The caller fetches the rows with the typed client, which is
 * what interprets every other column. Two queries instead of one, and the
 * second is an indexed `IN` over at most a page of ids. That second query is
 * already counted in the 7.6 ms above.
 *
 * These are `$queryRaw` tagged templates, so every `${}` below is a bound
 * parameter, not interpolated text. No identifier here comes from a caller.
 */

export interface SeekCursor {
  createdAt: Date;
  id: string;
}

/**
 * One page of platform_audit_entry ids, newest first.
 *
 * `after` is the last row of the previous page. Absent, this is page one.
 * Returns `limit + 1` ids so the caller can tell "there is another page"
 * without a second count.
 */
export async function auditPageIds(
  db: PrismaClient,
  opts: { limit: number; after?: SeekCursor },
): Promise<string[]> {
  const { limit, after } = opts;

  // `(createdAt, id) < (x, y)` is a row-value comparison: Postgres seeks
  // straight to that position in the (createdAt, id) index P34 adds. Split
  // into `createdAt < x OR (createdAt = x AND id < y)` it scans from the top
  // instead — the 17.4 ms measured above.
  const rows = after
    ? await db.$queryRaw<{ id: string }[]>`
        SELECT id FROM platform_audit_entry
         WHERE ("createdAt", id) < (${after.createdAt}::timestamptz, ${after.id})
         ORDER BY "createdAt" DESC, id DESC
         LIMIT ${limit + 1}`
    : await db.$queryRaw<{ id: string }[]>`
        SELECT id FROM platform_audit_entry
         ORDER BY "createdAt" DESC, id DESC
         LIMIT ${limit + 1}`;

  return rows.map((r) => r.id);
}

/**
 * One page of venue_org ids, oldest first.
 *
 * No tenant filter, deliberately: this is the cross-club club list, and the
 * binding that reaches it is `asPlatformAdmin`. Named so the reader does not
 * go looking for the filter every other repository has.
 */
export async function tenantPageIds(
  db: PrismaClient,
  opts: { limit: number; after?: SeekCursor },
): Promise<string[]> {
  const { limit, after } = opts;

  const rows = after
    ? await db.$queryRaw<{ id: string }[]>`
        SELECT id FROM venue_org
         WHERE ("createdAt", id) > (${after.createdAt}::timestamptz, ${after.id})
         ORDER BY "createdAt" ASC, id ASC
         LIMIT ${limit + 1}`
    : await db.$queryRaw<{ id: string }[]>`
        SELECT id FROM venue_org
         ORDER BY "createdAt" ASC, id ASC
         LIMIT ${limit + 1}`;

  return rows.map((r) => r.id);
}

/**
 * Restore the seek's order after a typed `findMany({ id: { in } })`.
 *
 * `IN` does not preserve order and Postgres is free to return those rows any
 * way it likes. Without this the page would be correctly SELECTED and wrongly
 * SORTED — which on an audit log reads as rows appearing out of sequence, and
 * on a cursor walk breaks the next cursor, because the last row of the page is
 * no longer the furthest along.
 */
export function inSeekOrder<T extends { id: string }>(
  rows: readonly T[],
  ids: readonly string[],
): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is T => r !== undefined);
}
