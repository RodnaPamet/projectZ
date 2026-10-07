import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability } from '@prisma/client';

import { ClubNotFoundError, setClubFeeTerms } from '@/app-layer/usecases/club-fees';
import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { checkPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { isCalendarDate, percentToBps } from '@/lib/billing/club-fee';
import { NotFoundError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * PUT /api/v1/platform/fees/{clubId}/terms — set a club's fee (#372).
 *
 * Body: `{ feePercent: "12.50", feeStartsOn: "2026-12-01", reason: "…" }`.
 * `feePercent` is 0–30 with at most two decimals, as a string or a number;
 * `feeStartsOn` is the first calendar day at the club on which the fee is
 * charged (the free period runs until the day before).
 *
 * ═══ A WRITE, SO A STEP-UP ═══
 *
 * CLUB_FEE_MANAGE is a write capability, enabled by name in
 * STEP_UP_PLATFORM_WRITES, so the binding demands a second-factor step-up on
 * this session from the last 15 minutes (403 STEP_UP_REQUIRED, or
 * MFA_ENROLMENT_REQUIRED) before it writes the audit row or the change. The
 * `reason` is the platform audit row's reason and goes into the club's own
 * audit row too, with the terms before and after (CLUB_FEE_TERMS_CHANGED).
 *
 * The new terms apply to fee lines written from now on. Lines already in the
 * ledger keep the rate and the free period they were charged with.
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

  const body = (await req.json().catch(() => null)) as {
    feePercent?: unknown;
    feeStartsOn?: unknown;
    reason?: unknown;
  } | null;

  const stated = checkPlatformReason(
    typeof body?.reason === 'string' ? body.reason : '',
    '`reason`',
  );
  if (!stated.ok) return stated.response;

  const rawPercent = body?.feePercent;
  const feeBps =
    typeof rawPercent === 'string' || typeof rawPercent === 'number'
      ? percentToBps(rawPercent)
      : null;
  if (feeBps === null) {
    throw new ValidationError('`feePercent` must be 0–30 with at most two decimals', {
      field: 'feePercent',
    });
  }

  const feeStartsOn = body?.feeStartsOn;
  if (typeof feeStartsOn !== 'string' || !isCalendarDate(feeStartsOn)) {
    throw new ValidationError('`feeStartsOn` must be a date as YYYY-MM-DD', {
      field: 'feeStartsOn',
    });
  }

  const actorUserId = ctx.userId;
  const result = await asPlatformAdmin(
    ctx,
    {
      capability: PlatformCapability.CLUB_FEE_MANAGE,
      action: 'PLATFORM_CLUB_FEE_TERMS_SET',
      reason: stated.reason,
      entity: 'VenueOrg',
      entityId: clubId,
      subjectTenantId: clubId,
      // What was asked for. The values it replaced are in the club's own
      // audit row, written in the same transaction once they are read.
      detailsJson: { feeBps, feeStartsOn },
    },
    async (db) => {
      try {
        return await setClubFeeTerms(db, {
          tenantId: clubId,
          feeBps,
          feeStartsOn,
          actorUserId,
          reason: stated.reason,
        });
      } catch (e) {
        // Inside the binding, so the platform audit row rolls back with it.
        if (e instanceof ClubNotFoundError) throw new NotFoundError('Club not found');
        throw e;
      }
    },
  );

  return ok({
    clubId,
    changed: result.changed,
    before: result.before,
    after: result.after,
  });
}

export const PUT = defineV1Route(handler);
