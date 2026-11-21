import { getToken } from 'next-auth/jwt';
import { type NextRequest } from 'next/server';

import { syncMyGoogleCalendar } from '@/app-layer/usecases/google-calendar';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';
import { CALENDAR_SYNC_LIMIT } from '@/lib/security/rate-limit';

/**
 * POST /api/v1/me/calendar/google/sync — «Синхронизирай сега» (owner
 * 2026-11-14). Runs a sync and answers `{ created, updated, deleted,
 * unchanged, skippedEdited, partial }`. 409 `GOOGLE_CALENDAR_REVOKED`: connect
 * again; 503 `GOOGLE_CALENDAR_UNAVAILABLE`: try later.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  return ok(await syncMyGoogleCalendar(ctx.userId));
}

export const POST = defineV1Route(handler, {
  rateLimit: {
    config: CALENDAR_SYNC_LIMIT,
    scope: 'calendar-sync',
    // Keyed on the account as well as the IP, as account deletion is.
    getUserId: async (req) => (await getToken({ req, secret: process.env.NEXTAUTH_SECRET }))?.sub,
  },
});
