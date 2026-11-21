import { type NextRequest } from 'next/server';

import { getMyCalendarStatus } from '@/app-layer/usecases/google-calendar';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/calendar — the caller's calendar sync (owner 2026-11-14):
 * `{ google: { connected, email, lastSyncAt, lastResult, error } }`. 404
 * `GOOGLE_CALENDAR_SYNC_DISABLED` while the feature is off: hide the switch.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  return ok(await getMyCalendarStatus(ctx.userId));
}

export const GET = defineV1Route(handler);
