import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability } from '@prisma/client';

import { loadClubStatement } from '@/app-layer/usecases/club-fees';
import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { readPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { readStatementMonth, statementCsvResponse } from '@/app/api/v1/_lib/statements';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/platform/fees/{clubId}/statement/csv?month=YYYY-MM&reason=… —
 * one club's statement as the CSV the owner invoices from (#372). The same
 * file the club downloads from its own page. TENANT_READ, audited as
 * `PLATFORM_FEE_STATEMENT_READ` with `format: 'csv'`.
 */
async function handler(req: NextRequest, { params }: { params: Promise<{ clubId: string }> }) {
  const { clubId } = await params;
  const ctx = await contextFromRequest(req, { requestId: getRequestId(), platformRoute: true });

  if (!ctx.userId) {
    return NextResponse.json(
      {
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required.',
          requestId: getRequestId(),
        },
      },
      { status: 401 },
    );
  }

  const sp = req.nextUrl.searchParams;
  const stated = readPlatformReason(sp);
  if (!stated.ok) return stated.response;
  const month = readStatementMonth(sp);

  const statement = await asPlatformAdmin(
    ctx,
    {
      capability: PlatformCapability.TENANT_READ,
      action: 'PLATFORM_FEE_STATEMENT_READ',
      reason: stated.reason,
      entity: 'VenueOrg',
      entityId: clubId,
      subjectTenantId: clubId,
      detailsJson: { month, format: 'csv' },
    },
    async (db) => {
      const s = await loadClubStatement(db, clubId, month);
      if (!s) throw new NotFoundError('Club not found');
      return s;
    },
  );

  return statementCsvResponse(statement);
}

export const GET = defineV1Route(handler);
