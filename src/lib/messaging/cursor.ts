/**
 * Opaque keyset cursors for the messaging reads (#375), ported from Agrent's
 * `lib/exchange/cursor`.
 *
 * ═══ KEYSET, NOT OFFSET ═══
 *
 * An offset SHIFTS: a message arriving between page 1 and page 2 pushes a row
 * across the boundary, so the reader sees one twice and never sees another. In
 * a conversation the thing duplicated or dropped is something a person said.
 *
 * ═══ THE ID IS IN THE CURSOR ═══
 *
 * A timestamp alone is not a total order: two rows with the same millisecond
 * straddle a page boundary and one is skipped or repeated. The id tiebreak
 * makes the order total, so a cursor names exactly one row.
 *
 * base64url and deliberately opaque: a position, not a timestamp a client
 * should read or build. A client that builds its own cursor has coupled itself
 * to the sort key.
 */

export interface Cursor {
  at: Date;
  id: string;
}

export function encodeCursor(row: { at: Date; id: string } | null | undefined): string | null {
  if (!row) return null;
  return Buffer.from(`${row.at.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

/**
 * Decode a cursor, or null when it is unusable. Null rather than a throw: a
 * stale or truncated cursor restarts the listing instead of answering 500. A
 * nonsense DATE is the case worth naming — `Invalid Date` compares false with
 * everything, so a filter built on it returns zero rows and reads as "no more
 * pages" rather than as an error.
 */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw || raw.length > 200) return null;
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const sep = decoded.indexOf('|');
  if (sep <= 0) return null;
  const at = new Date(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (!id || Number.isNaN(at.getTime())) return null;
  return { at, id };
}

/** The fields a keyset may order on, enumerated so a typo cannot build a predicate on another column. */
export type KeysetDateField = 'lastMessageAt' | 'createdAt';

/**
 * Strictly OLDER than the cursor row, for a DESCENDING `(field, id)` order:
 * the timestamp is behind, or it ties and the id is behind. A disjunction
 * because Prisma has no row-value comparison, and `field < at` alone drops the
 * tied rows.
 */
export function keysetBefore<F extends KeysetDateField>(
  cursor: Cursor,
  field: F,
): { OR: Array<Record<F, { lt: Date } | Date> | ({ id: { lt: string } } & Record<F, Date>)> } {
  return {
    OR: [
      { [field]: { lt: cursor.at } } as Record<F, { lt: Date }>,
      { [field]: cursor.at, id: { lt: cursor.id } } as { id: { lt: string } } & Record<F, Date>,
    ],
  };
}
