import { type NextRequest } from 'next/server';

import { googleCalendarConnectBodySchema } from '@/app-layer/schemas/google-calendar';
import { startGoogleCalendarConnect } from '@/app-layer/usecases/google-calendar';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/calendar/google/connect — the switch on (owner 2026-11-14).
 * `{"client":"ios"|"web"}` → `{ authorizeUrl }`. The client opens it (the
 * phone in an ASWebAuthenticationSession, the web as a navigation); Google
 * comes back to `/api/integrations/google-calendar/callback`, which stores the
 * connection, runs the first sync and redirects to the app scheme or the
 * profile page. The `state` in the URL is single-use and lives ten minutes.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  const body = await parseJsonBody(req, googleCalendarConnectBodySchema, 'connect');
  return ok(await startGoogleCalendarConnect({ userId: ctx.userId, client: body.client }));
}

export const POST = defineV1Route(handler);
