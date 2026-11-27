import { type NextRequest } from 'next/server';

import { getMyCalendarStatus } from '@/app-layer/usecases/google-calendar';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { requestLocale } from '@/app/api/v1/_lib/locale';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/calendar — the caller's calendar sync (owner 2026-11-14):
 * `{ google: { connected, email, lastSyncAt, lastResult, error,
 * disclosureVersion }, disclosure: { version, title, points, connect, cancel } }`.
 * `disclosure` is what to show before «Свържи» (#713), in the request's
 * language (`?locale=`, as the sport facts). 404
 * `GOOGLE_CALENDAR_SYNC_DISABLED` while the feature is off: hide the switch.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  return ok(await getMyCalendarStatus(ctx.userId, await requestLocale(req)));
}

export const GET = defineV1Route(handler);
