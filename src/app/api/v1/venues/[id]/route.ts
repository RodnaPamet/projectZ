import { type NextRequest } from 'next/server';

import { getVenueById } from '@/app-layer/repositories/venue';
import { asSuperuser } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { toVenueDetail } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * Public venue detail. Cross-tenant, unauthenticated.
 *
 * ═══ BY ID, NOT BY SLUG ═══
 *
 * `@@unique([tenantId, slug])` — slugs are unique WITHIN a tenant. Two clubs
 * can both own `central-courts`, so a public route holding only a slug cannot
 * say which one it means, and taking the first match would be a coin flip that
 * occasionally shows the wrong club's opening hours and phone number.
 *
 * The existing `getVenueBySlug` requires a tenantId for the same reason, which
 * makes it unusable here.
 *
 * ═══ params IS A PROMISE ═══
 *
 * Next 16 passes `params` as a Promise and its generated route validator reads
 * the LAST overload of the wrapper's type — the untransformed one. The
 * `AsyncifyParams` helper in errors/api.ts does not rescue a handler that types
 * this synchronously, despite its comment saying so. Type it as a Promise and
 * await it, or `next build` fails.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });

  // BYPASSRLS, for the same reason as the index: a public read has no tenant to
  // bind to, and `venue` has FORCE RLS. `status: ACTIVE` and the hand-written
  // DTO are what make that safe, not the tenant policy.
  const venue = await asSuperuser(ctx, (db) => getVenueById(db, id));

  // 404 rather than a null payload. A client that has to branch on
  // `data === null` will forget to, and render an empty venue page.
  if (!venue) throw new NotFoundError('Venue not found');

  return ok(toVenueDetail(venue));
}

export const GET = defineV1Route(handler);
