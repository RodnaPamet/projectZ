import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability, type TenantStatus } from '@prisma/client';

import {
  cancelUpcomingBookings,
  ClubNotFoundError,
  ClubStatusChangeError,
  setClubStatus,
} from '@/app-layer/usecases/club-status';
import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { checkPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * PUT /api/v1/platform/clubs/{clubId}/status — suspend, close or reopen a
 * club (#254).
 *
 * TENANT_SUSPEND, a step-up and a stated reason, all enforced by
 * `asPlatformAdmin`, which writes the platform's audit row in the same
 * transaction as the status. The club's own audit row is written there too
 * (`setClubStatus`).
 *
 * Going offline (SUSPENDED or CLOSED) then cancels the club's upcoming
 * bookings with notice, AFTER the status has committed: the club is hidden
 * and unbookable first, so no booking can slip in behind the cancellations.
 * The answer says how many were cancelled, how many failed, and how many are
 * left for another run past the per-run cap. Reopening cancels nothing and
 * restores nothing.
 */
const TARGETS: readonly TenantStatus[] = ['ACTIVE', 'SUSPENDED', 'CLOSED'];

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
    status?: unknown;
    reason?: unknown;
  } | null;

  const stated = checkPlatformReason(
    typeof body?.reason === 'string' ? body.reason : '',
    '`reason`',
  );
  if (!stated.ok) return stated.response;

  const to = body?.status;
  if (typeof to !== 'string' || !TARGETS.includes(to as TenantStatus)) {
    throw new ValidationError('`status` must be ACTIVE, SUSPENDED or CLOSED', { field: 'status' });
  }
  const target = to as TenantStatus;

  const actorUserId = ctx.userId;
  const changed = await asPlatformAdmin(
    ctx,
    {
      capability: PlatformCapability.TENANT_SUSPEND,
      action:
        target === 'ACTIVE'
          ? 'PLATFORM_CLUB_REOPENED'
          : target === 'SUSPENDED'
            ? 'PLATFORM_CLUB_SUSPENDED'
            : 'PLATFORM_CLUB_CLOSED',
      reason: stated.reason,
      entity: 'VenueOrg',
      entityId: clubId,
      subjectTenantId: clubId,
      detailsJson: { status: target },
    },
    async (db) => {
      try {
        return await setClubStatus(db, {
          tenantId: clubId,
          to: target,
          reason: stated.reason,
          actorUserId,
        });
      } catch (e) {
        if (e instanceof ClubNotFoundError) throw new NotFoundError('Club not found');
        if (e instanceof ClubStatusChangeError) {
          throw new ConflictError(
            `A ${e.from.toLowerCase()} club cannot become ${e.to.toLowerCase()}`,
          );
        }
        throw e;
      }
    },
  );

  const bookings =
    target === 'ACTIVE'
      ? { cancelled: 0, failed: 0, remaining: 0 }
      : await cancelUpcomingBookings({ tenantId: clubId, reason: stated.reason });

  return ok({ clubId, from: changed.from, to: changed.to, bookings });
}

export const PUT = defineV1Route(handler);
