import { type NextRequest, NextResponse } from 'next/server';
import { PlatformCapability } from '@prisma/client';

import {
  FUNNEL_DAY_OPTIONS,
  type FunnelDays,
  loadPlatformUsage,
} from '@/app-layer/usecases/usage-report';
import { asPlatformAdmin } from '@/app/api/v1/_lib/bind';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { rfc3339 } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { readPlatformReason } from '@/app/api/v1/_lib/platform-reason';
import { ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/platform/usage — the pilot's numbers (#371, Q40/Q48).
 *
 * Each club's online share of its bookings this month and last, its weekly
 * share for eight weeks, whether it is still active, and the booking funnel
 * for the whole site and per venue over the last 7, 30 or 90 days. The
 * definitions live in src/app-layer/usecases/usage-report.ts and
 * docs/usage-counts.md.
 *
 * Shaped like `/platform/tenants`, the reference platform read: the grant is
 * resolved for this request, a reason is required and checked before
 * authority, and the read runs through asPlatformAdmin under TENANT_READ,
 * which writes its audit row first. A read, so no step-up (#262 steps up
 * writes only). `subjectTenantId` is null: a report across every club is
 * about no single one.
 *
 * What it returns is counts. The funnel counters hold no person by
 * construction (P49); the club rows are booking totals, never bookings.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, {
    requestId: getRequestId(),
    platformRoute: true,
  });

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

  const days = readDays(sp.get('days'));

  const report = await asPlatformAdmin(
    ctx,
    {
      capability: PlatformCapability.TENANT_READ,
      action: 'PLATFORM_USAGE_READ',
      reason: stated.reason,
      entity: 'VenueOrg',
      subjectTenantId: null,
    },
    (db) => loadPlatformUsage(db, { days }),
  );

  return ok({
    ...report,
    clubs: report.clubs.map((c) => ({
      ...c,
      startedAt: rfc3339(c.startedAt),
      lastBookingAt: c.lastBookingAt ? rfc3339(c.lastBookingAt) : null,
    })),
  });
}

/** `?days=` — 7, 30 or 90; 30 when absent. Anything else is a 400, not a guess. */
function readDays(raw: string | null): FunnelDays {
  if (raw === null || raw === '') return 30;
  const n = Number(raw);
  if ((FUNNEL_DAY_OPTIONS as readonly number[]).includes(n)) return n as FunnelDays;
  throw new ValidationError(`\`days\` must be one of ${FUNNEL_DAY_OPTIONS.join(', ')}`, {
    field: 'days',
  });
}

export const GET = defineV1Route(handler);
