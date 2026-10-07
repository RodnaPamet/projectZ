import { type NextRequest } from 'next/server';

import { loadClubStatement } from '@/app-layer/usecases/club-fees';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import {
  readStatementMonth,
  requireStatementReader,
  toClubStatementDto,
} from '@/app/api/v1/_lib/statements';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/t/{slug}/admin/statements?month=YYYY-MM — the club's fee
 * statement for one month at the club (#372): its terms, the totals and every
 * line. OWNER and MANAGER only (`admin.billing_manage`).
 *
 * The lines come from the append-only ledger, so a month reads the same
 * however often it is asked for and whatever the club's terms are today. The
 * statement of a month nobody played in is an empty one, not a 404.
 *
 * The tenant binding confines the read to this club twice over: RLS on
 * `club_fee_line`, and `tenantId` in every WHERE of the use case. Another
 * club's slug is a 404 (see `requireStatementReader`).
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireStatementReader(ctx);

  const month = readStatementMonth(req.nextUrl.searchParams);
  const statement = await inTenant(ctx, (db) => loadClubStatement(db, ctx.tenantId, month));
  if (!statement) throw new NotFoundError('Club not found');

  return ok(toClubStatementDto(statement));
}

export const GET = defineV1Route(handler);
