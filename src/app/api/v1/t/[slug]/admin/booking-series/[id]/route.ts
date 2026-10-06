import { type NextRequest } from 'next/server';

import { getSeries } from '@/app-layer/usecases/desk-bookings';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { requireDesk } from '@/app/api/v1/_lib/desk';
import { toBookingSeries } from '@/app/api/v1/_lib/desk-dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/** A weekly series and every occurrence, cancelled ones included (#364). */
async function handler(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);

  const row = await inTenant(ctx, (db) => getSeries(db, ctx.tenantId, id));
  // Another club's series is invisible under RLS: the same 404 as none.
  if (!row) throw new NotFoundError('Series not found');
  return ok(toBookingSeries(row));
}

export const GET = defineV1Route(handler);
