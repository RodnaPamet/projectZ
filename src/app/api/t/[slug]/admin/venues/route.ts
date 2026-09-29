import { type NextRequest, NextResponse } from 'next/server';

import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { getRequestId } from '@/lib/observability/context';

/**
 * Venue administration.
 *
 * ═══ IT USED TO TRUST THE EDGE, AND SAID SO ═══
 *
 * "There is no permission check in this handler on purpose — the middleware
 * has already enforced `admin.venue_manage`." True until #250. The edge now
 * lets a signed-in caller through undecided when the token does not list the
 * club — a native token lists none, and a web token lists only the clubs it
 * signed in with — and skips its permission check, because it has no claim to
 * check.
 *
 * So the handler resolves its context like every other tenant route, and
 * `contextFromRequest` enforces the SAME rule from `ROUTE_PERMISSIONS` against
 * the role the database holds. Still one source of truth — the table — now
 * read in two places that cannot disagree about what it says.
 *
 * The real write path lands with the venue use cases; this establishes the
 * route so `route-permission-coverage` and `tenant-routes-resolve-membership`
 * have something to police.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // Throws 401/403 before the 501 for anyone who may not manage venues here.
  await contextFromRequest(req, { slug, requestId: getRequestId() });

  return NextResponse.json(
    { error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented' } },
    { status: 501 },
  );
}

export const POST = defineV1Route(handler);
