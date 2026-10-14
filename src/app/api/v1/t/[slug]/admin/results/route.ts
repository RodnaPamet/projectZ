import { type NextRequest } from 'next/server';

import { listClubResults } from '@/app-layer/usecases/match-results';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { requireDesk } from '@/app/api/v1/_lib/desk';
import { ok } from '@/app/api/v1/_lib/envelope';
import { ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

const STATUSES = ['REPORTED', 'CONFIRMED', 'REJECTED', 'DECIDED', 'VOIDED'] as const;

/**
 * GET /api/v1/t/{slug}/admin/results (#575): the club's results, newest first,
 * for its desk. `?status=REJECTED` is the ones that wait for the club
 * (decision 34). Needs `bookings.view_all`.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireDesk(ctx);
  const raw = req.nextUrl.searchParams.get('status');
  if (raw !== null && !(STATUSES as readonly string[]).includes(raw)) {
    throw new ValidationError('Invalid status', { field: 'status' });
  }
  const status = raw as (typeof STATUSES)[number] | null;
  const items = await inTenant(ctx, (db) =>
    listClubResults(db, ctx.tenantId, status ? { status } : {}),
  );
  return ok({ items });
}

export const GET = defineV1Route(handler);
