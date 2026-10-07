import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability } from '@prisma/client';

import { loadClubStatement } from '@/app-layer/usecases/club-fees';
import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { readPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { readStatementMonth, toClubStatementDto } from '@/app/api/v1/_lib/statements';
import { NotFoundError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/platform/fees/{clubId}/statement?month=YYYY-MM&reason=… — one
 * club's statement, as the club sees it on its own page (#372), for a holder of
 * TENANT_READ. Audited as `PLATFORM_FEE_STATEMENT_READ`, naming the club.
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
      detailsJson: { month, format: 'json' },
    },
    async (db) => {
      const s = await loadClubStatement(db, clubId, month);
      // Thrown inside, so the audit row rolls back: nothing was read.
      if (!s) throw new NotFoundError('Club not found');
      return s;
    },
  );

  return ok(toClubStatementDto(statement));
}

export const GET = defineV1Route(handler);
