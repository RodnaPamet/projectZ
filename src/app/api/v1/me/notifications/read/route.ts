import { type NextRequest } from 'next/server';

import { markReadBodySchema } from '@/app-layer/schemas/notifications';
import {
  markMyNotificationsRead,
  NotificationNotFoundError,
} from '@/app-layer/usecases/my-notifications';
import { parseJsonBody } from '@/app/api/v1/_lib/body';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { ok } from '@/app/api/v1/_lib/envelope';
import { NotFoundError, UnauthorizedError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * POST /api/v1/me/notifications/read — mark the caller's notifications read
 * (#367): `{ "ids": [...] }` (1–100) or `{ "all": true }`.
 *
 * Idempotent, and never un-reads. An id that is not the caller's — another
 * person's or none at all — is 404 for the whole call and marks nothing, so a
 * client cannot tell the two apart. Answers `{ marked, unreadCount }`.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const body = await parseJsonBody(req, markReadBodySchema, 'body');

  try {
    const result = await markMyNotificationsRead({
      userId: ctx.userId,
      ...('all' in body ? { all: true } : { ids: body.ids }),
    });
    return ok(result);
  } catch (err) {
    if (err instanceof NotificationNotFoundError) throw new NotFoundError('Notification not found');
    throw err;
  }
}

export const POST = defineV1Route(handler);
