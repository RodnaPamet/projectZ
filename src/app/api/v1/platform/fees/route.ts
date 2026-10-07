import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability } from '@prisma/client';

import { loadFeeOverview } from '@/app-layer/usecases/club-fees';
import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { readPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { readStatementMonth, toFeeOverviewRowDto } from '@/app/api/v1/_lib/statements';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/platform/fees?month=YYYY-MM&reason=… — every club's fee for one
 * month (#372): what the owner invoices from.
 *
 * Each club with its terms today, how much of the month its free period
 * covers, and the month's totals summed from the ledger: online bookings
 * played, their revenue and the fee due. Clubs with nothing that month are
 * listed at zero rather than left out.
 *
 * ═══ TENANT_READ, NOT THE FEE CAPABILITY ═══
 *
 * Reading the statements is reading every club's operational data, which is
 * what TENANT_READ is for, and it needs no step-up: the owner invoices from
 * this page and downloads each club's CSV from it. Changing a club's terms is
 * CLUB_FEE_MANAGE, a write behind a step-up (`…/fees/{clubId}/terms`).
 *
 * Like every platform read it is audited with the reason the reader states
 * (`PLATFORM_FEE_OVERVIEW_READ`), and the reason is checked before authority.
 */
async function handler(req: NextRequest) {
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

  const overview = await asPlatformAdmin(
    ctx,
    {
      capability: PlatformCapability.TENANT_READ,
      action: 'PLATFORM_FEE_OVERVIEW_READ',
      reason: stated.reason,
      entity: 'ClubFeeLine',
      // Every club, so about no single one.
      subjectTenantId: null,
      detailsJson: { month },
    },
    (db) => loadFeeOverview(db, month),
  );

  return ok({
    month,
    clubs: overview.rows.map(toFeeOverviewRowDto),
    truncated: overview.truncated,
  });
}

export const GET = defineV1Route(handler);
