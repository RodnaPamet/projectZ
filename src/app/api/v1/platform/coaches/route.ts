import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability } from '@prisma/client';

import {
  COACH_QUEUE_STATUSES,
  CoachApplicationNotFoundError,
  listCoachApplications,
  type CoachQueueStatus,
} from '@/app-layer/usecases/coach-approval';
import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { toCoachApplicationItem } from '@/app/api/v1/_lib/coach-dto';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { page } from '@/app/api/v1/_lib/envelope';
import { readPlatformCursor, UnknownPlatformCursorError } from '@/app/api/v1/_lib/platform-cursor';
import { readPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/platform/coaches?status=SUBMITTED&reason=…&cursor=…
 *
 * The coaches' profiles sent for the platform owner's approval (#545; owner
 * decision 13). `status` is `SUBMITTED` (the default: the queue, oldest
 * first), `APPROVED` or `DECLINED` (newest decision first). A draft is never
 * listed: nothing was sent.
 *
 * Needs a live grant carrying `COACH_APPROVE` and, because that capability
 * also opens certificates and writes decisions, a second-factor step-up from
 * the last 15 minutes: 403 `STEP_UP_REQUIRED` without one. `reason`
 * is required and goes into the audit row every page read writes
 * (`PLATFORM_COACH_APPLICATION_LIST`).
 *
 * Each item names the coach, the sports and levels, and whether a certificate
 * is on file. The certificate itself is `…/coaches/{userId}/certificate`.
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
  const paged = readPlatformCursor(sp);
  if (!paged.ok) return paged.response;

  const rawStatus = sp.get('status') ?? 'SUBMITTED';
  const status = COACH_QUEUE_STATUSES.find((s) => s === rawStatus);
  if (!status) {
    throw new ValidationError('`status` must be SUBMITTED, APPROVED or DECLINED', {
      field: 'status',
    });
  }

  const { items, nextCursor } = await asPlatformAdmin(
    ctx,
    {
      capability: PlatformCapability.COACH_APPROVE,
      action: 'PLATFORM_COACH_APPLICATION_LIST',
      reason: stated.reason,
      entity: 'CoachProfile',
      subjectTenantId: null,
      detailsJson: { status: status as CoachQueueStatus },
    },
    async (db) => {
      try {
        return await listCoachApplications(db, { status, after: paged.cursor ?? null });
      } catch (e) {
        // The cursor's row left this list since the page before it.
        if (e instanceof CoachApplicationNotFoundError) throw new UnknownPlatformCursorError();
        throw e;
      }
    },
  );
  return page(items.map(toCoachApplicationItem), nextCursor);
}

export const GET = defineV1Route(handler);
