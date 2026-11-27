import { type NextRequest } from 'next/server';

import { disconnectMyGoogleCalendar } from '@/app-layer/usecases/google-calendar';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { noContent } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * DELETE /api/v1/me/calendar/google — the switch off (owner 2026-11-14):
 * revokes the grant at Google and deletes the connection. 204, also when
 * nothing was connected. The «playerz» calendar and its events stay in the
 * person's Google account and stop being updated (see the use case).
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');
  await disconnectMyGoogleCalendar(ctx.userId);
  return noContent();
}

export const DELETE = defineV1Route(handler);
