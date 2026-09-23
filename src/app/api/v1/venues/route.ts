import { type NextRequest } from 'next/server';

import { clampLimit, listVenues } from '@/app-layer/repositories/venue';
import { asSuperuser } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { toVenueSummary } from '@/app/api/v1/_lib/dto';
import { page } from '@/app/api/v1/_lib/envelope';
import { toV1ErrorResponse } from '@/app/api/v1/_lib/errors';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { getRequestId } from '@/lib/observability/context';

/**
 * Public venue search. Cross-tenant, unauthenticated.
 *
 * ═══ WHY asSuperuser, AND WHY THAT IS NOT LAZINESS ═══
 *
 * `venue` carries FORCE ROW LEVEL SECURITY with a policy keyed on
 * `app.tenant_id`. A public search has no tenant — a player hunting a padel
 * court in Sofia does not know which club owns it — so binding `inTenant` is
 * impossible and binding nothing fails closed.
 *
 * Measured against the database:
 *
 *     app_user, no tenant bound   0 rows
 *     app_superuser               1 row
 *
 * The non-versioned `/api/venues` passes the raw Prisma singleton instead. That
 * works today ONLY because the dev connection role is a cluster superuser and
 * is exempt from row security. Point it at the least-privileged role from P24
 * and that route returns an empty list, silently, in production.
 *
 * So the BYPASSRLS binding is the correct one here, and `status: ACTIVE` plus
 * the hand-written DTO are what keep it safe rather than the tenant policy.
 */
async function handler(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });

  const result = await asSuperuser(ctx, (db) =>
    listVenues(
      db,
      {
        q: sp.get('q') ?? undefined,
        city: sp.get('city') ?? undefined,
        sport: (sp.get('sport') as never) ?? undefined,
        indoor: sp.has('indoor') ? sp.get('indoor') === 'true' : undefined,
        maxPriceCents: sp.has('maxPrice') ? Number(sp.get('maxPrice')) : undefined,
      },
      {
        cursor: sp.get('cursor') ?? undefined,
        // Not advisory. Without a ceiling this is a one-request DoS: an
        // unauthenticated GET asking for a million rows.
        limit: clampLimit(sp.has('limit') ? Number(sp.get('limit')) : undefined),
      },
    ),
  );

  return page(result.items.map(toVenueSummary), result.nextCursor);
}

export const GET = defineV1Route(handler);
