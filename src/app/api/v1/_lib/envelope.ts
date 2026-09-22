import { NextResponse } from 'next/server';

import { API_VERSION, API_VERSION_HEADER } from '@/lib/api-version';

/**
 * The success envelope.
 *
 * ═══ WHY EVERYTHING IS WRAPPED ═══
 *
 * A bare array cannot grow. `GET /venues` returning `[...]` has nowhere to put
 * a cursor, a total, or a deprecation notice without breaking every client that
 * already parses it — and on a native client, "every client" includes binaries
 * installed months ago that will never be updated.
 *
 * So responses are objects from the first commit, even where an array would do.
 * This is the cheapest compatibility decision available and it is only cheap
 * before anything ships.
 */

export interface Page<T> {
  items: T[];
  /** Opaque. A client passes it back verbatim and never parses it. */
  nextCursor: string | null;
}

function withVersion(res: NextResponse): NextResponse {
  // Stamped on every v1 response, success included. `api-version.ts` describes
  // this as a marker consumers can log and alert on; a marker that only appears
  // on errors is one nobody sees until something is already wrong.
  res.headers.set(API_VERSION_HEADER, API_VERSION);
  return res;
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return withVersion(NextResponse.json({ data }, init));
}

export function page<T>(items: T[], nextCursor: string | null): NextResponse {
  return withVersion(NextResponse.json({ data: { items, nextCursor } satisfies Page<T> }));
}

/** 204, for a delete that succeeded. No body, so no envelope. */
export function noContent(): NextResponse {
  return withVersion(new NextResponse(null, { status: 204 }));
}
