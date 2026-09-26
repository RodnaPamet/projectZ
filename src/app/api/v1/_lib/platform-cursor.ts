import { NextResponse } from 'next/server';

import { getRequestId } from '@/lib/observability/context';

/**
 * The paging cursor for a platform read, validated in two places for two
 * different failures.
 *
 * ═══ WHY AN UNKNOWN CURSOR MUST BE AN ERROR ═══
 *
 * Prisma resolves `cursor: { id }` through a subquery: `WHERE createdAt >=
 * (SELECT createdAt FROM t WHERE id = $1)`. When the id matches nothing that
 * subquery is NULL, the comparison is NULL, and the query returns ZERO ROWS —
 * measured, not assumed.
 *
 * Zero rows means `hasMore` is false, which means `nextCursor` is null, which
 * means the client is told **the walk is complete**. HTTP 200, empty page, no
 * indication of anything wrong.
 *
 * On the audit log that is precisely the failure the cursor was added to
 * prevent, wearing a different hat: a reader who believes they have seen
 * everything and has seen nothing. A typo in a cursor, a row deleted between
 * pages, or a cursor copied from the other endpoint all produce it.
 *
 * So a cursor naming no row is a 400. A client that gets one has a bug; a
 * client that gets a silent empty page does not know it has one.
 *
 * ═══ WHY THE SHAPE IS CHECKED SEPARATELY ═══
 *
 * A cursor containing a NUL byte makes Postgres reject the query outright, and
 * the resulting PrismaClientKnownRequestError is unmapped — a client-triggered
 * 500. Checking the shape before the query turns that into the 400 it always
 * was. The pattern is deliberately permissive: every id in this schema is a
 * cuid, and the point is to exclude bytes that have no business in one, not to
 * re-validate cuid's format.
 */

/** cuid-shaped enough: no NUL, no whitespace, no path separators. */
const CURSOR_SHAPE = /^[A-Za-z0-9_-]{8,64}$/;

const invalid = (why: string) =>
  NextResponse.json(
    {
      error: {
        code: 'INVALID_CURSOR',
        requestId: getRequestId(),
        message:
          `${why} Pass back the \`nextCursor\` from the previous page exactly as it was ` +
          `given, and stop when it is null.`,
      },
    },
    { status: 400 },
  );

export type CursorResult =
  { ok: true; cursor: string | undefined } | { ok: false; response: NextResponse };

/** Absent is fine — that is page one. Present and malformed is not. */
export function readPlatformCursor(params: URLSearchParams): CursorResult {
  const raw = params.get('cursor')?.trim();
  if (!raw) return { ok: true, cursor: undefined };

  if (!CURSOR_SHAPE.test(raw)) {
    return { ok: false, response: invalid('That cursor is not a well-formed one.') };
  }

  return { ok: true, cursor: raw };
}

/**
 * Thrown from inside the binding when the cursor names no row.
 *
 * An exception rather than a return value because the check belongs in the same
 * transaction as the read — a row could be deleted between a pre-flight check
 * and the query — and the binding's callback has nowhere to put a response.
 */
export class UnknownPlatformCursorError extends Error {
  constructor() {
    super(
      'The cursor names no row. Prisma resolves a cursor through a subquery, so an unknown ' +
        'one returns zero rows rather than raising — which would tell the caller the walk ' +
        'was complete when it had read nothing.',
    );
    this.name = 'UnknownPlatformCursorError';
  }
}
