import { type NextRequest, NextResponse } from 'next/server';

/**
 * Venue administration.
 *
 * There is no permission check in this handler on purpose — the middleware
 * has already enforced `admin.venue_manage` via ROUTE_PERMISSIONS, and the
 * `route-permission-coverage` guardrail fails the build if a rule is
 * missing. Duplicating the check here would create two sources of truth
 * that can drift.
 *
 * The real write path lands with the venue use cases; this establishes the
 * route so the guardrail has something to police.
 */
export async function POST(_req: NextRequest) {
  return NextResponse.json(
    { error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented' } },
    { status: 501 },
  );
}
