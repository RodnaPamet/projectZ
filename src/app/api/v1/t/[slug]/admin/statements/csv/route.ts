import { type NextRequest } from 'next/server';

import { loadClubStatement } from '@/app-layer/usecases/club-fees';
import { inTenant } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import {
  readStatementMonth,
  requireStatementReader,
  statementCsvResponse,
} from '@/app/api/v1/_lib/statements';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/t/{slug}/admin/statements/csv?month=YYYY-MM — the same statement
 * as a CSV download (#372): UTF-8 with a BOM, semicolon-separated, Bulgarian
 * headers (see src/lib/billing/statement-csv.ts for why each).
 *
 * Same permission and same answers as the JSON route; an error is still the
 * JSON envelope, because a client that asked for a file and got a refusal
 * must be able to read why.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await contextFromRequest(req, { slug, requestId: getRequestId() });
  requireStatementReader(ctx);

  const month = readStatementMonth(req.nextUrl.searchParams);
  const statement = await inTenant(ctx, (db) => loadClubStatement(db, ctx.tenantId, month));
  if (!statement) throw new NotFoundError('Club not found');

  return statementCsvResponse(statement);
}

export const GET = defineV1Route(handler);
