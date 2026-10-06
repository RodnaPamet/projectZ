import { type NextRequest } from 'next/server';

import { notificationIdSchema } from '@/app-layer/schemas/notifications';
import {
  listMyNotifications,
  NotificationCursorError,
} from '@/app-layer/usecases/my-notifications';
import { contextFromRequest } from '@/app/api/v1/_lib/context';
import { defineV1Route } from '@/app/api/v1/_lib/define-route';
import { toNotificationDto } from '@/app/api/v1/_lib/dto';
import { ok } from '@/app/api/v1/_lib/envelope';
import { UnauthorizedError, ValidationError } from '@/lib/errors/types';
import { getRequestId } from '@/lib/observability/context';

/**
 * GET /api/v1/me/notifications — the caller's bell (#367), newest first.
 *
 * Cursor paged: `nextCursor` is the last item's id, passed back as `cursor`;
 * `limit` is clamped to 1..50 (default 20). A cursor that names no
 * notification of the caller's is a 400, not an empty page. The answer also
 * carries `unreadCount`, so the badge and the list come from one read.
 *
 * The user is the session's. Every row is the caller's own: the query is
 * bound to them (owner-only RLS) and filtered by them.
 */
async function handler(req: NextRequest) {
  const ctx = await contextFromRequest(req, { slug: null, requestId: getRequestId() });
  if (!ctx.userId) throw new UnauthorizedError('Authentication required');

  const sp = req.nextUrl.searchParams;
  const cursor = sp.get('cursor') || null;
  if (cursor && !notificationIdSchema.safeParse(cursor).success) {
    throw new ValidationError('Invalid cursor', { field: 'cursor' });
  }

  try {
    const { items, nextCursor, unreadCount } = await listMyNotifications({
      userId: ctx.userId,
      cursor,
      limit: sp.has('limit') ? Number(sp.get('limit')) : undefined,
    });
    return ok({ items: items.map(toNotificationDto), nextCursor, unreadCount });
  } catch (err) {
    if (err instanceof NotificationCursorError) {
      throw new ValidationError('Unknown cursor', { field: 'cursor' });
    }
    throw err;
  }
}

export const GET = defineV1Route(handler);
